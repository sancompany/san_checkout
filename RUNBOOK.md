# RUNBOOK — San Checkout

Como operar, reverter, restaurar e responder a incidente. Escrito em
13/09/2026, na auditoria retrógrada da Estação 3.

Este arquivo diz o que **é verdade hoje**. Onde algo não foi testado,
está escrito que não foi — item não testado é hipótese, e hipótese em
runbook é pior que ausência.

---

## 1. Onde as coisas rodam

| peça | onde | endereço |
|---|---|---|
| Backend (Node/Express) | Northflank, `southamerica-east` (Osasco) | `https://api.sancocore.com.br` |
| Frontend estático | Cloudflare Pages, projeto `san-checkout` | `https://checkout.sancocore.com.br` |
| Banco | Supabase, projeto `San_Checkout`, `sa-east-1` (São Paulo) | ref `zacuaroarelaqnzjjlcz` |
| Pagamento | Asaas — **sandbox** hoje (`ASAAS_AMBIENTE`) | `api-sandbox.asaas.com` |
| Porta do `/admin` | Cloudflare Access, equipe `fancy-dawn-740a` | política "Somente o operador"; nove destinos, inclusive `/api/admin` e as prévias `*.san-checkout.pages.dev` (`CONSTRAINTS.md` §2.6) |
| Proxy do admin | Pages Function `functions/api/admin/[[caminho]].js`, atrás do Access | `checkout.sancocore.com.br/api/admin/*` → `api.sancocore.com.br` |
| Repositório | GitHub `sancompany/san_checkout`, branch `main` | — |
| Ping externo | cron-job.org, a cada 10 min em `/api/saude` | mantém Supabase ativo |

Aplicação e banco na mesma região — medido em 13/09/2026 do navegador do
operador: rota sem banco 20-29 ms, rota com uma consulta 70-295 ms.

## 1.1 Inventário de contas

**Por que esta seção existe:** quem construiu tem tudo na cabeça até o
dia em que o cartão do registrador expira e o domínio cai. A tabela
abaixo é para outra pessoa conseguir operar sem falar com quem
construiu.

O que a sessão **mediu** — pelas APIs dos próprios provedores, em
17/09/2026 — está escrito. O que continua `⬜` é o que **nenhuma API
responde**: onde a senha mora e qual cartão paga. Isso não é preguiça de
medir, é limite do que existe para ser medido; inventar aqui seria pior
que deixar em branco.

**E uma coisa que a API responde e mesmo assim não fica escrita aqui: o
e-mail de login.** Ele é metade de um par de autenticação, e a regra
desta seção é a mesma da §1.2 — ponteiro, nunca credencial. Quem tem a
credencial do provedor descobre o endereço com um comando (abaixo);
quem não tem, pega no gerenciador junto da senha. Escrever o e-mail de
login de nove contas num arquivo versionado é entregar metade do
caminho a quem só precisava da outra.

| conta | para que | identificadores medidos | login | senha e 2º fator | renovação / quem paga |
|---|---|---|---|---|---|
| **registro.br** | domínio `sancocore.com.br` | registrado 31/08/2026, **vence 31/08/2027**; contato técnico `BRHSA71`; status `active` (RDAP) | ⬜ | ⬜ | **31/08/2027** · cartão ⬜ |
| **Cloudflare** | DNS da zona, Pages (4 projetos), Access (equipe `fancy-dawn-740a`), Web Analytics | zona `sancocore.com.br`, plano **Free Website**, NS `arely`/`decker`; os ids de conta e de zona saem do comando abaixo, não deste arquivo | e-mail pessoal do dono — o endereço **não fica escrito aqui**, sai do comando abaixo ou do gerenciador | **2FA ativo** (medido) · gerenciador ⬜ | **nada é pago**: `Cloudflare Free Plan` e `Teams Free Base`, ambos US$ 0 — a linha do Teams renova 11/10/2026 sem cobrança |
| **Northflank** | backend | projeto/serviço `san-checkout`, cluster `nf-southamerica-east`, namespace `ns-9k49mqwtltxm`, criado 12/09/2026, branch `main`, build `nf-compute-400-16`, runtime `nf-compute-50` | ⬜ | ⬜ | mensal ⬜ · cartão ⬜ |
| **Supabase** | banco | org `fphbzkrzgijqzpqzvshh`, projeto `San_Checkout` ref `zacuaroarelaqnzjjlcz`, `sa-east-1`, Postgres 17.6.1.166, criado 06/09/2026 | ⬜ | ⬜ | plano ⬜ · cartão ⬜ |
| **Asaas** | pagamento | conta **pessoa física, em transição** (`CONSTRAINTS.md` §3); hoje `sandbox` | ⬜ | ⬜ | tarifa por transação · sem mensalidade conhecida ⬜ |
| **GitHub** | repositório e CI | `sancompany/san_checkout`; **os dois workflows não usam segredo de repositório** (medido) | ⬜ | ⬜ | plano ⬜ |
| **Google Workspace** | caixas `@sancocore.com.br` (`contato`, `financeiro`, `juridico`, `suporte`) | MX `smtp.google.com`, DKIM seletor `google`, DMARC `p=reject` — **sem registro SPF** (medido em dois resolvedores) | ⬜ | ⬜ | por caixa ⬜ · cartão ⬜ |
| **cron-job.org** | ping de 10 min em `/api/saude` | mantém o Supabase acordado | ⬜ | ⬜ | gratuito ⬜ |

**O que a conta da Cloudflare serve além do checkout**, e importa numa
troca de credencial: quatro projetos de Pages na mesma conta —
`san-checkout` (`checkout.sancocore.com.br`), `san-core`
(`sancocore.com.br`), `san-humano` (`humano.sancocore.com.br`) e
`mostrai`. A credencial ali é a conta inteira (`CONSTRAINTS.md` §3):
mexer nela alcança os quatro.

**Como reconferir o que foi medido** (nenhum destes comandos imprime
segredo; o primeiro não precisa de credencial nenhuma):

```bash
# vencimento do domínio — o item que mais cai, e o único que ninguém avisa.
# Não precisa de credencial nenhuma.
curl -s https://rdap.registro.br/domain/sancocore.com.br \
  | python3 -c "import sys,json;[print(e['eventAction'],e['eventDate']) for e in json.load(sys.stdin)['events']]"
```

Para a Cloudflare, os dois cabeçalhos de autenticação da API (o e-mail e
a chave global, os dois lidos do ambiente e nunca escritos aqui) ficam
numa função, definida uma vez:

```bash
# cole no terminal; lê do ambiente, não imprime nada
cf() { curl -sS -H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}" "$@"; }

# quem é a conta, e o 2FA está ligado?
cf https://api.cloudflare.com/client/v4/user \
  | python3 -c "import sys,json;r=json.load(sys.stdin)['result'];print(r['email'],'2FA:',r['two_factor_authentication_enabled'])"

# o id da zona, quando algum comando pedir — descobrir na hora é melhor
# que guardar aqui: id escrito em documento envelhece sem ninguém notar
cf "https://api.cloudflare.com/client/v4/zones?name=sancocore.com.br" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['id'])"
```

**O SPF está no ar desde 18/09/2026**, e por que isso importa: com DKIM
e `p=reject` o e-mail do Google já chegava por alinhamento de DKIM — foi
o que a conferência do item 1 da prontidão viu. O que faltava cobria o
resto: receptor que pesa SPF via `none`, e qualquer caminho que quebre a
assinatura DKIM (encaminhamento, provedor transacional novo) seria
**rejeitado**, não classificado como spam. Para um endereço que é canal
legal do titular (`juridico@`), silêncio é descumprimento.

O registro é `v=spf1 include:_spf.google.com ~all`, na raiz da zona.
Para conferir que continua lá — vale a pena depois de qualquer mexida em
DNS, porque isto cai sem gerar erro:

```bash
for r in https://dns.google/resolve https://cloudflare-dns.com/dns-query; do
  curl -s -H "accept: application/dns-json" \
    "$r?name=sancocore.com.br&type=TXT" | grep -o 'v=spf1[^"]*'
done
```

⚠️ **Se um provedor transacional de e-mail entrar um dia, o `include`
dele entra NESTE registro.** Dois `v=spf1` na mesma zona invalidam os
dois — o resultado é `permerror`, que é pior que não ter nenhum.

## 1.2 Segredos: onde moram e como rotacionar

**Regra:** aqui vai o *ponteiro*, nunca o segredo. Nenhum valor desta
tabela é escrito neste arquivo, em commit, em issue ou em log.

| segredo | onde mora | quem usa | como rotacionar | o que a rotação invalida |
|---|---|---|---|---|
| `ASAAS_API_KEY` | variável do serviço no Northflank | backend, em toda chamada à Asaas | painel da Asaas → chaves de API: gerar nova, colar no Northflank (o serviço reinicia), **revogar a antiga só depois** | nada nosso; cobrança em andamento não é afetada |
| `ASAAS_WEBHOOK_TOKEN` | Northflank **e** painel da Asaas (Integrações → Webhooks) | receptor de webhook | trocar nos **dois** lugares, com o mesmo valor | ver o aviso abaixo |
| `SUPABASE_SERVICE_KEY` | Northflank | backend, todo acesso ao banco | painel do Supabase → API keys → rotate | todo backend que usa a chave, na hora |
| `CHECKOUT_ADMIN_USER` / `CHECKOUT_ADMIN_PASS_HASH` | Northflank | login do `/admin` | `node scripts/gerar-hash-admin.js` e trocar o hash | **todas as sessões abertas**, por construção |
| Token pessoal do Supabase (`SUPABASE_ACCESS_TOKEN`) | ambiente de quem opera, nunca no serviço | `npm run limpar-teste`, `npm run ensaio-restauracao`, `npm run expurgo` | conta do Supabase → Access tokens | os scripts de operação, não o sistema no ar |
| Credencial do Cloudflare | ambiente de quem opera | DNS, Pages, Access | painel do Cloudflare → API tokens | **é a conta inteira** — exceção registrada em `CONSTRAINTS.md` §3 |
| GitHub | — | CI | — | **não há segredo de repositório** (medido: nenhum `secrets.` nos dois workflows) |

**A rotação do token de webhook não tem janela sem risco, e é melhor
saber antes:** o código aceita **um** token por vez. Trocado primeiro no
Northflank, a Asaas entrega com o token velho e leva `503`; trocado
primeiro na Asaas, o mesmo pelo outro lado. Qualquer das ordens acumula
falha, e **15 seguidas pausam a fila da conta** (`CONSTRAINTS.md` §2.3).
Então: trocar nos dois lugares em sequência imediata, em horário de
tráfego baixo, e conferir a aba Webhook do painel logo depois. Aceitar
dois tokens durante a virada resolveria — não está construído, e está
declarado em `docs/pendencias.md`.

> ⚠️ **`northflank get service` imprime os valores das variáveis.**
> Rodar isso numa sessão ou num terminal compartilhado vaza a chave da
> Asaas inteira na saída — aconteceu em 17/09/2026, com a chave de
> sandbox, e ela entrou na fila de rotação por isso. Para ver só os
> nomes:
>
> ```bash
> northflank get service --project san-checkout --service san-checkout -o json \
>   | python3 -c "import sys,json;d=json.load(sys.stdin);e=(d.get('data') or d)['runtimeEnvironment'];print(len(e),sorted(e.keys()))"
> ```
>
> São **11** hoje. A primeira versão desta receita filtrava a saída
> bonita com `grep -oE '^ +[A-Z][A-Z0-9_]+:'` e devolvia **10** — comia
> justamente a `ASAAS_AMBIENTE`, que vem na mesma linha da abertura do
> bloco. Quem fosse auditar a troca para produção (§6.2, passo 4)
> concluiria que a variável não existe. Ler o JSON e pegar as chaves é
> exato: não depende de indentação e nunca imprime valor.

## 2. Está no ar?

```
curl -sS https://api.sancocore.com.br/api/saude
```

Resposta boa: `200` com `{"status":"ok",…,"supabaseRespondendo":true,`
`"alertasChaveAsaas":[]}`. Banco fora → `503` com `"status":"degradado"`.

- `503`/`supabaseRespondendo: false` → banco fora ou pausado por
  inatividade. O serviço está no ar mas não cobra nem concilia.
- `alertasChaveAsaas` não vazio → a chave da Asaas está expirando ou foi
  apagada. Gerar nova no painel da Asaas e trocar `ASAAS_API_KEY` **no
  Northflank**.

**Alerta de queda: o que existe hoje é o e-mail de falha da Asaas.**
Decisão do dono em 17/09/2026, com a ressalva escrita de que **tráfego
zero não dispara nada** — sistema parado sem cobrança e sem mexida na
conta não gera aviso. O sinal técnico existe (`/api/saude` → `200 ok` /
`503 degradado` / sem resposta); o que não existe é alguém escutando por
conta própria. A tabela de "aviso → primeira ação" é a §6.3.

> **Esta seção trazia, até 17/09/2026, um tutorial de ~30 linhas para
> montar dois monitores** (integração do Northflank + UptimeRobot), e
> ele descrevia um plano de 14/09 que a decisão de 17/09 substituiu.
> Plano superado dentro do manual de operação é pior que ausência: quem
> lesse acharia que os monitores existem. A receita não foi jogada fora
> — está em `docs/proximas-versoes.md`, pronta para o dia em que for
> decidido montar.

**O ping externo de 10 minutos é o ponto mais incerto deste arquivo.** A
§1 o lista como `cron-job.org`, e o tutorial removido acima dizia
"trocar o cron-job.org **que caiu**". Uma das duas afirmações é falsa, e
**daqui não é verificável**: o serviço é externo, não tem credencial
neste ambiente e não deixa rastro no nosso lado. Quem sabe é o painel do
cron-job.org — está na lista de `⬜` da §1.1. O que o ping faz, se
estiver de pé, é manter o Supabase do plano gratuito acordado; a queda
dele não derruba nada, só deixa a primeira requisição do dia lenta.

## 3. Publicar

**O que publica é a `main`**, sozinha, nos dois lugares: Northflank
(CI+CD do GitHub, branch `main`) e Cloudflare Pages (produção = `main`).
Nenhuma outra branch vai para produção — empurrar uma branch de trabalho
é seguro nesse sentido.

**Mas ninguém trabalha na `main`, e esta seção não ensinava o caminho
até ela.** O fluxo real, do jeito que o histórico mostra (merges
`(#15)`, `(#16)`, `(#17)`):

```bash
# 0. de onde você está partindo — antes de qualquer coisa
git status              # árvore limpa? você está em qual branch?
git fetch origin main   # a main local envelhece em silêncio
git log --oneline -1 origin/main

# 1. trabalhar numa branch própria, nunca direto na main
git checkout -b <sua-branch>            # ou continuar na que já existe
git add -A && git commit -m "<o quê>"
git push -u origin <sua-branch>

# 2. antes de pedir merge, rodar a mesma porta que o CI roda
npm run check           # análise de sintaxe de todo JS + as suítes

# 3. abrir o PR e mesclar (a porta é o CI verde — ver abaixo)
#    https://github.com/sancompany/san_checkout/pulls
```

> **Decisão do dono, 18/09/2026: mesclar assim que estiver pronto, sem
> pedir.** "Mescla na main SEMPRE que tiver pronto já mescle." Ou seja: a
> sessão não espera autorização caso a caso para mesclar — a porta
> continua sendo o **CI verde**, não uma pessoa, e é ela que decide.
>
> Duas coisas que essa decisão NÃO muda, e é importante que não mudem:
> **mesclar é publicar** (a main vai para produção sozinha), então o que
> não estiver pronto não vira commit na branch; e a lista curta da skill
> `leis` continua valendo — caminho de dinheiro, segredo, migration
> destrutiva e contrato que outro projeto consome seguem exigindo
> autorização para serem CONSTRUÍDOS. O que o dono dispensou é o pedido
> de "posso mesclar?", não o de "posso fazer?".

`npm run check` **é seguro rodar local**: o runner injeta valores falsos
só para os módulos carregarem, e nenhuma suíte toca banco, rede ou
relógio. Não precisa de `.env`.

**A porta é o CI verde, não uma pessoa.** Dois workflows: `testes`
(roda `npm run check` — a mesma linha do passo 2, análise de sintaxe de
todo JS e depois as suítes; até 18/09/2026 rodava só `npm test`, e o
código de `public/js/` ficava fora do portão) e `Segurança`
(dependências, segredos, análise estática).
Onde olhar se ficou verde:

- **https://github.com/sancompany/san_checkout/actions** — é a única
  forma pela web, e vale dizer: **o `gh` não está instalado** nesta
  máquina, então não há comando de terminal para isso aqui.

**Qual commit está no ar AGORA** — a pergunta que a §4 precisa
responder antes de reverter qualquer coisa, e que `/api/saude` não
responde (o payload não traz versão):

```bash
# o commit que o Northflank está servindo
northflank get service --project san-checkout --service san-checkout -o json \
  | python3 -c "import sys,json;d=json.load(sys.stdin);d=(d.get('data') or d);print(d['deployment']['internal']['deployedSHA'])"

# e ele é o mesmo que a main?
git fetch origin main && git log --oneline -1 origin/main
```

> Sem isso, a §4 mandava `git revert <sha-ruim>` sem dizer de onde vem o
> sha — e reverter por palpite é como se troca um bug por dois. Furo
> achado pelo teste da pessoa número dois (§10) em 17/09/2026: ele
> conseguiu dizer que o sistema estava no ar e **não** conseguiu dizer
> qual versão estava no ar.

**O cache de 4h em JS e CSS acabou** — o dono trocou o Browser Cache TTL
da zona em 14/09/2026. Medido no mesmo dia:

```
GET /js/admin.js   cache-control: public, max-age=1, must-revalidate
GET /css/admin.css cache-control: public, max-age=1, must-revalidate
```

Eram `max-age=14400`. Com 1 segundo, o navegador revalida praticamente
sempre e recebe `304` pelo ETag — o arquivo novo chega na primeira
recarga, e o Ctrl+Shift+R deixou de ser obrigatório depois de deploy.

> **O que ainda é sobreposição.** O nosso `_headers` pede `max-age=0` e a
> zona entrega `1`: quem decide continua sendo o painel, não o
> repositório. Isso é irrelevante hoje e passa a importar no dia em que
> algum asset precisar de cache longo (arquivo com hash no nome, por
> exemplo) — aí o alvo é *Respect Existing Headers*, e a decisão volta
> para o `_headers`.

## 4. Reverter

**Caminho certo e testado: reverter no git.**

```
git revert <sha-ruim>     # cria um commit que desfaz, sem reescrever histórico
git push
```

O push republica os dois lados. Tempo: o CI leva ~15 s (testes) e ~35 s
(segurança); o build do Northflank e o do Pages vêm depois.
**Tempo total de volta ao ar: não medido** — medir na próxima reversão
real e escrever aqui.

**Nunca reescrever histórico na `main`.** Os dois comandos que destroem,
pelo nome exato: **`git push --force`** (e `--force-with-lease`, que só é
menos pior) e **`git reset --hard`**. Reverter é commit novo — `git
revert` —, nunca apagar o commit ruim. Este repositório já perdeu
trabalho uma vez por reescrita de histórico
(`docs/erros/2026-09-11-filter-repo-apagou-trabalho-nao-commitado.md`).

> Até 17/09/2026 esta linha proibia `git reset --force`, **que não
> existe**: o `git reset` não tem essa bandeira. Proibição que nomeia
> comando inexistente não protege de nada e deixa os dois de verdade
> sem nome — achado pelo teste da pessoa número dois (§10), que foi
> conferir o comando.

**Rollback pelo painel do Northflank** (redeploy de um build anterior)
existe como caminho alternativo e **não foi testado neste projeto**. Não
usar como primeira opção sem testar antes, fora de incidente.

## 5. Variável de ambiente

Nomes em `.env.example` (nunca valores). A ordem tem duas metades e ela
importa:

1. A variável nova existe **antes** do código que a usa subir.
2. A antiga só sai **depois** que o código que a usava saiu do ar.

Trocar na ordem errada derruba a produção entre um passo e o outro — já
aconteceu (`docs/erros/2026-09-11-variavel-trocada-antes-do-codigo-subir.md`).

Valor com `$`, crase, contrabarra ou aspas vai **codificado em base64**;
o painel trata `$` como substituição de shell e trunca o resto
(`docs/erros/2026-09-11-cifrao-em-variavel-de-ambiente.md`).

## 5.1 A API é DNS-only, não passa pelo Cloudflare

`api.sancocore.com.br` é **registro DNS sem proxy** (nuvem cinza):
resolve direto para o Northflank, sem o Cloudflare no caminho. Conferido
14/09/2026 — a resposta traz `server: istio-envoy` e **não** traz
`cf-ray` (só `checkout.sancocore.com.br`, o front no Pages, é proxied).
`api.sancocore.com.br` e o endereço direto `pay--…--….code.run` são,
portanto, **a mesma porta pública** do backend: não existe borda do
Cloudflare na API para contornar.

Consequência prática: **uma Transform Rule do Cloudflare não se aplica à
API** (o Cloudflare não a proxia — o próprio painel avisa isso ao criar
a regra). Um esquema de "segredo injetado pelo Cloudflare" só
funcionaria se a API fosse posta atrás do proxy laranja primeiro. Ver
`docs/erros/2026-09-14-origem-direta-alcancavel-por-fora.md`.

Quem protege a API é a **auth de aplicação** (token de sessão do admin,
`X-Checkout-Key` do contratante, HMAC do webhook de saída, token do
webhook de entrada) — não uma camada de borda. **Desde 25/09/2026 a área
administrativa tem também a primeira camada NA ORIGEM:** `/api/admin/*`
só responde com o JWT do Cloudflare Access (`Cf-Access-Jwt-Assertion`),
que só a função do Pages atrás do Access repassa — pela API ou pela
origem direta, sem ele é `401 acessoRestrito` antes da senha
(`CONSTRAINTS.md` §2.6, "A camada 1 também na origem"). Fechar a API atrás do
Cloudflare para ganhar WAF/limite de borda é decisão de infra do dono,
não feita: exigiria ligar o proxy em `api.sancocore.com.br` com SSL
Full (strict) e conferir o certificado da origem. Está em
`docs/pendencias.md` como opção, não como pendência bloqueante.

## 5.2 Autorizar um domínio de retorno do contratante

O contratante pede "meu comprador não volta para a minha loja depois de
pagar". O checkout honra `?returnUrl=` no link, mas **só** para origens
do próprio contratante — senão qualquer um montaria um link com o nosso
domínio na frente levando para o site dele (open redirect). Ver
`API.md` §3.1 e `src/utils/retornoSeguro.js`.

A origem do `apiBaseUrl` dele **já vale**, sem cadastrar nada. Só
precisa de cadastro quando a vitrine está em outra origem — o caso
comum: API em `api.loja.com.br`, loja em `www.loja.com.br`.

No painel → Contratantes → editar → campo **retornoDominios**: uma
origem `https` por linha. O backend normaliza cada uma para origem
(`https://www.loja.com.br`) e **descarta o caminho** — cadastrar
`https://www.loja.com.br/obrigado` autoriza a origem inteira, não só
aquela página. Até 10 entradas.

Recusado com "precisa ser uma lista (até 10) de origens https com host
público" = alguma linha é `http://`, host interno, ou não é URL.

Conferir sem abrir o navegador — a resposta traz o destino aprovado ou
`null`:

```
curl -sS "https://api.sancocore.com.br/api/checkout/pedido/{contratante}/{pedido}?returnUrl=https%3A%2F%2Fwww.loja.com.br%2Fok"
```

**De onde saem os dois ids** (com os nomes entre chaves, como estão
acima, a resposta é `404` — e isso confunde quem tenta colar e rodar):
`{contratante}` é o id cadastrado no painel `/admin` → Contratantes,
coluna id; `{pedido}` é um id que **o próprio contratante gera** no
sistema dele, então sai do lado dele — ou de uma linha de `cobrancas`
que já exista. Sem um par real, este `curl` não tem como funcionar.

**Nunca cadastrar um domínio que não seja do contratante.** É a única
forma de este mecanismo virar open redirect, e a fronteira de confiança
aqui é exatamente a mesma do `webhook_url`.

## 6. Restaurar o banco

### O que existe hoje, sem enfeite

| | estado |
|---|---|
| Procedimento de restauração | **existe e foi exercitado** — `npm run ensaio-restauracao` |
| RTO medido | **1 s** de máquina (16/09/2026) |
| Backup automático | **NÃO EXISTE** |
| RPO | **indefinido** — sem job de cópia, no pior caso perde-se tudo |

As duas linhas de baixo são a exceção da Lei 6 no `CONSTRAINTS.md` §3,
com gatilho na primeira cobrança real. **Saber restaurar não é ter
backup:** hoje existe o procedimento provado e não existe a cópia.

### Como restaurar

Restaurar aqui é **aplicar as migrations e carregar os dados** — o schema
mora em `supabase/migrations/`, versionado e imutável (`CONSTRAINTS.md`
§2.1), não num arquivo de dump.

```bash
# 1. os dados (COM dado real — só em ambiente confiável)
node scripts/backup-dados.mjs dados.sql --com-dado-real

# 2. schema: TODAS as migrations, em ordem numérica, pelo editor SQL do
#    Supabase ou psql. Não confie no número escrito aqui — liste o
#    diretório:  ls supabase/migrations/
#    (eram 6 quando esta receita foi escrita e são 9 desde 17/09/2026;
#     restaurar até a 0006 dá um banco SEM a tabela de erros (0007), sem
#     `confirmado_em` (0008) e sem `ambiente`/`e_teste` (0009) — o
#     restore "daria certo" e estaria errado, que é o mesmo modo de
#     falha contra o qual o ON_ERROR_STOP abaixo protege)
# 3. carregar dados.sql com ON_ERROR_STOP ligado
psql -v ON_ERROR_STOP=1 -f dados.sql "<conexão>"
```

`ON_ERROR_STOP=1` não é zelo: o padrão do `psql` é **seguir em erro, em
silêncio** — é assim que um restore "bem-sucedido" chega quebrado.

### O ensaio, e o que ele prova

```bash
npm run ensaio-restauracao
```

Sobe um Postgres descartável da **mesma major da produção** (17), aplica
as migrations, carrega um despejo **anonimizado**, e compara o resultado
com a produção em cinco níveis: colunas, restrições, índices, RLS e
contagem de linhas. Uma divergência reprova e o comando sai com 1.

Ele também é o **único lugar do projeto que prova que
`supabase/migrations/` ainda descreve o que está no ar** — um `pg_dump`
nunca provaria: copiaria a divergência junto. Verificado por sabotagem em
16/09: coluna a mais no restaurado → `ENSAIO REPROVOU`.

Os dados do ensaio saem **anonimizados por padrão**, mascarados dentro do
banco. Não se puxa base de produção para máquina de desenvolvimento, e o
CPF certo não é necessário para provar que o restore funciona.

### Último ensaio

| | |
|---|---|
| Data | **16/09/2026** |
| Resultado | **PASSOU** — 98 colunas, 10 restrições, 20 índices, 6 tabelas com RLS, 6 contagens, zero divergência |
| RTO | **1 s** |
| Postgres | produção 17.6 · ensaio 17.11 |

A lei pede ensaio com menos de trinta dias. **Refazer até 16/10/2026**, e
depois de qualquer mudança de versão, extensão ou ferramenta.

> ⚠️ **A tabela acima ficou desatualizada em 22/09/2026** — desde 16/09
> entraram cinco migrations novas (`0010`…`0014`), quatro delas com
> `constraint` nova (0013 e 0014). Verificado **parcialmente** no mesmo
> dia em que este aviso foi escrito: as **14** migrations (`0001`…`0014`)
> aplicam limpo, em ordem, num Postgres 17.11 descartável — zero erro,
> só os `NOTICE` esperados dos guardas `IF NOT EXISTS`/`IF EXISTS`
> (schema-only, sem dado, RTO de 1 s). O que **não** foi refeito é a
> metade que exige credencial de produção (o despejo anonimizado e a
> comparação de cinco níveis) — a sessão que fez essa verificação não
> tinha `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` no shell (só acesso via
> MCP, que nesse momento estava pedindo aprovação que ninguém deu). Os
> números novos e corretos de colunas/restrições/índices/RLS só saem de
> `npm run ensaio-restauracao` de verdade — **é esse o próximo a
> rodar**, com credencial, antes de confiar na tabela acima de novo.

> O RTO de 1 s é **tempo de máquina**. O relógio de um incidente começa
> antes, em perceber que caiu — e isso depende do alerta externo, que é
> item aberto (§2 e `docs/pendencias.md`).

## 6.1 Onde olhar quando algo quebrou

Nesta ordem, da resposta mais rápida para a mais cara:

1. **Painel `/admin` → aba Erros.** Toda exceção que virou 5xx, dos
   últimos 30 dias, agrupada por onde acontece. `ocorrencias` diz se é
   rajada ou caso isolado; `ultima_vez`, se ainda está acontecendo.
   É o primeiro lugar, porque responde "o quê e onde" sem login em
   provedor nenhum.
2. **Painel `/admin` → aba Filas** (desde 24/09/2026). Se o sintoma é
   "o contratante não foi avisado" ou "o pedido ficou pendente", olhe
   primeiro aqui: a **inbox** lista todo evento da Asaas com o desfecho
   (`processado`, `falhou` + último erro, `ignorado`), e a **outbox**
   toda notificação ao contratante com o status HTTP que ele devolveu.
   Os dois botões (**reenfileirar** / **reenviar**) refazem a operação
   com o MESMO id — o contratante deduplica, então reenviar nunca credita
   duas vezes. Só depois a aba Webhook (auditoria redigida, inclusive do
   que o código não trata).
3. **`GET /api/saude`.** Diz se banco e chave da Asaas estão de pé,
   traz o alerta de chave prestes a expirar e, desde 24/09/2026,
   `filas` (`inbox.pendentes/esgotadas`, `outbox.pendentes/abandonadas`)
   e `workers` (a última rodada de cada worker: inbox 60 s, outbox 30 s,
   reconciliador de reservas 5 min). `esgotadas`/`abandonadas` acima de
   zero é trabalho para gente; `workers` sem rodada recente com o
   processo de pé é bug.
4. **Log do Northflank.** Retenção curta, e é o único lugar com 4xx e
   com o que aconteceu antes do erro. Último recurso, não o primeiro.
   **Só pelo painel:** `app.northflank.com` → projeto `san-checkout` →
   serviço `san-checkout` → aba Logs. **O CLI não tem comando de log** —
   conferido em 17/09/2026: `northflank logs` não existe (cai no help
   geral), e em `get`/`list` só há `log-sink`, que é o destino de
   exportação, não a leitura. Escrevi aqui um `northflank logs …` antes
   de conferir, e ele não roda; a correção é esta linha.

> **Os dois primeiros passos exigem entrar no `/admin`, e isso trava
> quem não tem a credencial.** O `/admin` está atrás do Cloudflare
> Access (equipe `fancy-dawn-740a`) **e** de usuário e senha próprios —
> e os dois estão em `⬜` na §1.1. Para quem não os tem, esta lista
> começa no passo 3. É um limite real do estado atual, não do
> procedimento: sem o acesso preenchido, a pessoa número dois diagnostica
> com uma mão nas costas. Achado pelo teste do §10.

**O que a aba Erros NÃO mostra, de propósito:** 4xx (validação recusada é
o sistema funcionando), corpo da requisição, cabeçalho e a URL com
valores. Se a pergunta é "qual pedido era?", a resposta sai de `contexto`
+ `ultima_vez` cruzados com `cobrancas`, não do log — que nunca guarda o
`pedidoId`, porque ele é credencial (`docs/inventario-de-dados.md` §7.2).

## 6.2 Trocar a Asaas de sandbox para produção

Fecha a exceção §3 do `CONSTRAINTS.md`. **A ordem importa** — cada passo
existe porque a ordem inversa quebra algo.

> ⚠️ Antes de começar, leia `API.md §11.1`: **nada de sandbox atravessa.**
> Assinatura de teste para de existir, cobrança de teste vira histórico
> morto, e `walletId` é outro. Não há migração.

### Passo 1 — no painel da Asaas de PRODUÇÃO

1. Gerar a `ASAAS_API_KEY` de produção (Integrações → Chave de API).
2. Criar o webhook apontando **exatamente** para:

   ```
   https://api.sancocore.com.br/api/webhooks/asaas
   ```

   **Plural em `webhooks`.** Errar isto significa nenhuma cobrança
   confirmada, sem aviso. E a conferência **só funciona com `POST`** —
   medido ao vivo em 17/09/2026, as quatro combinações:

   | caminho | GET | POST sem token |
   |---|---|---|
   | `/api/webhooks/asaas` (certo) | 404 | **401** — a guarda existe e recusou |
   | `/api/webhook/asaas` (errado) | 404 | **404** — rota não existe |

   Com `GET` os dois devolvem 404 e parecem iguais: quem conferir com um
   `curl` comum vai achar que a URL certa está errada. O comando que
   distingue:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'content-type: application/json' --data '{}' \
     https://api.sancocore.com.br/api/webhooks/asaas     # espera 401
   ```

   Esta linha dizia só "o plural responde 401 e o singular responde
   404", sem o método — e foi o teste da pessoa número dois (§10) que
   mostrou que, do jeito escrito, a conferência não distinguia nada.

3. Definir um **token de autenticação** no webhook, e guardá-lo — ele vai
   para `ASAAS_WEBHOOK_TOKEN`. Sem token, o nosso receptor recusa tudo
   (fail-closed, por desenho).
4. Marcar os eventos. São **53**, medidos no sandbox em 17/09 — o porquê
   de cada grupo está em `CONSTRAINTS.md` §2.2, e a lista para conferir
   item a item está no fim desta seção.

### Passo 2 — desativar TODO webhook que não é o novo

No painel, desativar (ou apagar) o webhook de sandbox e **qualquer
endereço de hospedagem antiga que ainda esteja cadastrado**. Se ficar
ligado, ele passa a acumular falha — e depois de 15 seguidas a Asaas
**pausa a fila** daquela conta (§2.3).

**Isto já aconteceu, e não foi hipótese.** Em 17/09/2026 a URL do Render
— hospedagem que o projeto deixou de usar — ainda estava configurada, e
a mudança de registro da conta de PJ para PF disparou um evento do grupo
"Situação da conta" que tentou ser entregue lá. Falhou, e a Asaas mandou
o e-mail de penalidade.

Duas lições que valem para a troca:

1. **Configuração de webhook sobrevive a troca de hospedagem**, e nada
   no código sabe disso. É a mesma classe do "identificador preso ao
   ambiente" do `API.md` §11.1: o que quebra está fora do repositório.
2. **Não são só eventos de pagamento que disparam entrega.** O grupo
   "Situação da conta" tem 18 eventos marcados e dispara sozinho quando
   algo muda na conta — então um endereço morto acumula falha mesmo com
   tráfego zero de cobrança.

### Passo 3 — limpar os registros de teste

```bash
# o corte é a hora de início do processo que subiu com as variáveis de produção
northflank exec service --project san-checkout --service san-checkout --cmd "stat -c %y /proc/1"

npm run limpar-teste -- --ate=<corte ISO, UTC>          # simulação: mostra, não apaga
npm run limpar-teste -- --ate=<corte> --apagar --confirmo-que-e-sandbox
```

Apaga os registros operacionais de sandbox em **dez tabelas** —
`cobrancas`, `assinaturas`, `intencoes_troca_plano`, `webhook_inbox`,
`outbox_notificacoes`, `cotacoes`, `clientes_asaas`, `webhook_eventos`,
`webhook_rejeicoes`, `erros` — e nunca toca `contratantes` nem
`subcontas`. Tudo numa **transação única**: ou apaga o conjunto inteiro,
ou nada.

"De sandbox" é o que foi gravado **antes do corte** `--ate` (obrigatório,
sem padrão: depois da troca, "agora" incluiria linha de produção nas
tabelas que não marcam o ambiente), e em `clientes_asaas` é
`ambiente = 'sandbox'`. As travas rodam na simulação e de novo dentro da
transação, e qualquer uma desfaz tudo: tabela de `public` sem
classificação no script; cobrança do conjunto com `ambiente` diferente de
`sandbox`; cliente de produção anterior ao corte (corte tarde demais);
assinatura, cotação ou intenção do conjunto ligada a linha que fica; e,
depois dos `delete`, contagem de `contratantes`/`subcontas` alterada ou
`testemaster`/`mostrai` ausentes.

**Rodado em 24/09/2026, depois da troca** (corte `2026-09-24T23:28:57Z`,
início do PID 1 do contêiner de produção): 121 linhas apagadas, os dois
contratantes intactos. Antes disso, as seis travas foram provadas por
sabotagem dentro de transação desfeita — inclusive a última, que só
dispara depois dos 121 `delete` e deixou o banco igual. A versão anterior
do script era de antes das migrations 0011 e 0015 e ignorava cinco
tabelas; a trava de classificação existe para a próxima migration não
repetir isso.

**Antes da troca, não depois.** O motivo está no `API.md §11.1`:
assinatura de sandbox que sobrevive no nosso registro vira zumbi —
`/cancelar-assinatura` chama a Asaas de produção com um id de sandbox,
leva 404, e a linha que gravaria o status novo nunca roda. O registro
fica `ativa` para sempre, incancelável pela API. Rodar logo depois da
troca também serve — foi o que aconteceu em 24/09 —, porque o corte
`--ate` separa o que o processo de sandbox gravou; o que não serve é
deixar para depois de haver tráfego real, quando um zumbi já pode ter
sido consultado pelo contratante.

### Passo 4 — as três variáveis no Northflank

| variável | de | para |
|---|---|---|
| `ASAAS_AMBIENTE` | `sandbox` | `producao` |
| `ASAAS_API_KEY` | a de sandbox | a do passo 1 |
| `ASAAS_WEBHOOK_TOKEN` | a de sandbox | o token do passo 1.3 |

**Depois** do passo 1, nunca antes: chave de produção sem webhook de
produção é cobrança que ninguém confirma. O serviço reinicia sozinho.

Nada de código muda. `public/js/utils/api.js` e o `connect-src` do
`_headers` já apontam para `api.sancocore.com.br` desde 12/09 — trocar de
host seria trocar o CNAME, não editar arquivo.

### Passo 5 — conferir, e é a parte que a exceção §3 exige

A exceção diz, com estas palavras, que a segunda rodada precisa
reconferir **os quatro pontos que mudam entre ambientes**, um a um:

1. **identificador de cobrança** — o `pay_…` novo resolve na consulta?
2. **formato do webhook** — o payload de produção tem os mesmos caminhos?
3. **assinatura** — o token novo passa pela guarda?
4. **mensagem de erro** — o texto que a Asaas devolve é o mesmo?

Só um pagamento real de valor baixo responde os quatro. Roteiro no
`API.md §11.1`, passo 5.

<details>
<summary>Os 61 eventos, para conferir no painel (medidos em 17/09/2026, atualizados em 18/09/2026 depois de o dono marcar mais 9 e desmarcar 1)</summary>

```
ACCESS_TOKEN_DELETED
ACCESS_TOKEN_DISABLED
ACCESS_TOKEN_EXPIRED
ACCESS_TOKEN_EXPIRING_SOON
ACCOUNT_STATUS_BANK_ACCOUNT_INFO_APPROVED
ACCOUNT_STATUS_BANK_ACCOUNT_INFO_AWAITING_APPROVAL
ACCOUNT_STATUS_BANK_ACCOUNT_INFO_PENDING
ACCOUNT_STATUS_BANK_ACCOUNT_INFO_REJECTED
ACCOUNT_STATUS_COMMERCIAL_INFO_APPROVED
ACCOUNT_STATUS_COMMERCIAL_INFO_AWAITING_APPROVAL
ACCOUNT_STATUS_COMMERCIAL_INFO_EXPIRED
ACCOUNT_STATUS_COMMERCIAL_INFO_EXPIRING_SOON
ACCOUNT_STATUS_COMMERCIAL_INFO_PENDING
ACCOUNT_STATUS_COMMERCIAL_INFO_REJECTED
ACCOUNT_STATUS_DOCUMENT_APPROVED
ACCOUNT_STATUS_DOCUMENT_AWAITING_APPROVAL
ACCOUNT_STATUS_DOCUMENT_PENDING
ACCOUNT_STATUS_DOCUMENT_REJECTED
ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED
ACCOUNT_STATUS_GENERAL_APPROVAL_AWAITING_APPROVAL
ACCOUNT_STATUS_GENERAL_APPROVAL_PENDING
ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED
BALANCE_VALUE_BLOCKED
BALANCE_VALUE_UNBLOCKED
CHECKOUT_CANCELED
CHECKOUT_EXPIRED
CHECKOUT_PAID
INTERNAL_TRANSFER_CREDIT
INTERNAL_TRANSFER_DEBIT
PAYMENT_APPROVED_BY_RISK_ANALYSIS
PAYMENT_AWAITING_CHARGEBACK_REVERSAL
PAYMENT_AWAITING_RISK_ANALYSIS
PAYMENT_CHARGEBACK_REQUESTED
PAYMENT_CONFIRMED
PAYMENT_CREDIT_CARD_CAPTURE_REFUSED
PAYMENT_OVERDUE
PAYMENT_PARTIALLY_REFUNDED
PAYMENT_RECEIVED
PAYMENT_RECEIVED_IN_CASH_UNDONE
PAYMENT_REFUNDED
PAYMENT_REFUND_DENIED
PAYMENT_REFUND_IN_PROGRESS
PAYMENT_REPROVED_BY_RISK_ANALYSIS
PAYMENT_SPLIT_CANCELLED
PAYMENT_SPLIT_DIVERGENCE_BLOCK
PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED
PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED
SUBSCRIPTION_CREATED
SUBSCRIPTION_DELETED
SUBSCRIPTION_INACTIVATED
SUBSCRIPTION_SPLIT_DISABLED
SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK
SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK_FINISHED
SUBSCRIPTION_UPDATED
TRANSFER_BLOCKED
TRANSFER_CANCELLED
TRANSFER_CREATED
TRANSFER_DONE
TRANSFER_FAILED
TRANSFER_IN_BANK_PROCESSING
TRANSFER_PENDING
```

</details>

## 6.3 Alerta → o que significa → primeira ação

A pergunta que esta tabela responde é a única que importa às 3 da manhã:
**chegou um aviso, e agora?**

| o aviso | de onde vem | o que significa | primeira ação |
|---|---|---|---|
| e-mail da Asaas: falha na entrega de webhook | Asaas, a cada falha | nossa URL recusou ou não respondeu | conferir **qual URL** o e-mail cita: pode ser hospedagem antiga ainda cadastrada (§6.2, passo 2). Sendo a atual, seguir §8 |
| a fila de webhook pausou | Asaas (e o sintoma: pagamento pago e não confirmado) | 15 falhas seguidas | reativar no painel e **conciliar** (`API.md` §5.2 e §5.3) |
| `/api/saude` devolvendo 503 | curl, ou o ping de 10 min do cron-job.org | banco inalcançável **ou** worker parado (desde 25/09/2026) — o corpo diz qual: `supabaseRespondendo: false`, ou `workersAtrasados` não vazio | banco: §6.1, item 3 e 4; se for o Supabase, §6 (restaurar) só depois de confirmar que não é rede. Worker: a linha de baixo |
| aba **Erros** do painel crescendo | captura de exceção (migration 0007) | 5xx acontecendo agora | `ocorrencias` + `ultima_vez` dizem se é rajada; §6.1 |
| `/api/saude` → `filas.inbox.esgotadas > 0` | curl / aba Filas | um evento da Asaas falhou 8 vezes no processamento (o `200` já foi dado; o evento está guardado) | ler `ultimo_erro` na aba Filas; corrigir a causa; **reenfileirar** — nunca pedir reenvio à Asaas |
| `/api/saude` → `filas.outbox.abandonadas > 0` | curl / aba Filas | o contratante recusou 8 vezes (1 min … 24 h) | ver `ultimo_status_http`; avisar o contratante; **reenviar** quando ele voltar — mesmo `eventoId`, ele deduplica |
| `/api/saude` → `workersAtrasados` não vazio (e o HTTP 503) | curl / o monitor de uptime | o processo está de pé, mas aquele worker está sem uma passada bem-sucedida há mais de 3 intervalos dele + 2 min: pendurado numa chamada, ou falhando a cada rodada | aba **Erros** e o log daquele worker (`[inbox]`, `[outbox]`, `[estornos]`…) dizem se é falha repetida; se for pendura, reiniciar o serviço (§4) e abrir erro. A regra é `utils/passadas.js`, `workersAtrasados`. Terceiro lento sozinho não dispara isto: as passadas da inbox (120 s) e da outbox (60 s) têm orçamento e deixam o resto para o próximo tique |
| aba **Erros**: `PAGAMENTO DUPLICADO` | cancelador de irmãs (RN-52) | o mesmo pedido foi pago duas vezes — os dois pagamentos são reais e estão `confirmado` | listar todos (a linha de `erros` agrega por origem e guarda só a última mensagem): `select contratante_id, pedido_id, charge_id, metodo_pagamento, pagamento_duplicado_com from cobrancas where pagamento_duplicado_em is not null`; combinar com o contratante qual devolver e estornar **um** (`POST /api/checkout/estornar` ou painel da Asaas). Nunca apagar a linha |
| aba **Erros**: `cancelamento de irmã ESGOTADO` | cancelador de irmãs (RN-51) | um Pix/boleto/pop-up de pedido já pago segue pagável na Asaas depois de 8 tentativas | ver `cancelamento_ultimo_erro` da linha; excluir à mão no painel da Asaas. Se ela tiver sido paga nesse meio-tempo, é o caso de cima. Para o cancelador tentar de novo: `update cobrancas set cancelamento_tentativas = 0, cancelamento_proxima_em = now() where id = '<id>'` |
| build ou deploy vermelho | Northflank / GitHub Actions | o que está no ar continua o commit anterior | §3 e §4; CI vermelho **não** publica |

**O que NÃO existe, e é decisão registrada:** alerta que acorda alguém.
O canal é o e-mail de falha da Asaas, escolhido pelo dono em 17/09/2026,
**com a ressalva escrita de que tráfego zero não dispara nada** — um
sistema parado sem cobrança nenhuma não gera aviso. `docs/pendencias.md`
e `CONSTRAINTS.md` §3.

## 7. Mudar schema

Pelo **editor do Supabase**, e a mudança vira migration numerada nova em
`supabase/migrations/`. Migration aplicada nunca é editada; corrige-se
com outra. Coluna acrescentada depois da primeira ida a produção precisa
de `alter table ... add column if not exists` no corpo executável — em
comentário não roda
(`docs/erros/2026-09-11-coluna-nao-criada-por-create-table-if-not-exists.md`).

Nunca alterar schema por conexão direta com `DATABASE_URL`.

## 8. Incidente

**A fila de webhook da Asaas pausa depois de 15 falhas seguidas.** É o
incidente mais provável, e o mais silencioso: as cobranças continuam
sendo pagas e nenhuma confirmação chega.

1. Conferir a aba **Webhook** do painel admin (eventos recebidos, e
   quantos ficaram `nao_tratado`).
2. Conferir no painel da Asaas se a fila está pausada, e reativar.
3. Conciliar o que passou. As duas rotas reconsultam a Asaas e corrigem
   o banco — enxergam o pagamento que o webhook perdeu. Os comandos,
   aqui mesmo, porque no incidente ninguém abre outro documento:

   ```bash
   # pedido avulso — GET (API.md §5.2)
   curl -sS -H "X-Checkout-Key: <a chave DO CONTRATANTE>" \
     "https://api.sancocore.com.br/api/checkout/cobranca/<contratanteId>/<pedidoId>"

   # assinatura — POST com corpo, e NÃO GET (API.md §5.3): o documento
   # identifica o assinante, e documento em caminho de URL vaza para log
   # de acesso, histórico e referer
   curl -sS -X POST -H "X-Checkout-Key: <a chave DO CONTRATANTE>" \
     -H 'content-type: application/json' \
     --data '{"planoId":"<planoId>","documento":"<só dígitos>"}' \
     "https://api.sancocore.com.br/api/checkout/consultar-assinatura"
   ```

   A chave é a do contratante (painel `/admin` → Contratantes), não uma
   credencial nossa — é a mesma que ele usa na integração, e ela já
   identifica de quem é a cobrança. O formato da resposta e os campos que
   ela corrige estão em `API.md` §5.2 e §5.3.

**Contratante fora do ar não é mais problema nosso.** Desde 15/09/2026 o
aviso ao contratante não segura a resposta à Asaas, e cada tentativa tem
teto de 10 s. Antes, um parceiro que aceitasse a conexão e não
respondesse segurava a nossa resposta — e 15 dessas pausariam a fila da
conta inteira, atingindo todos os contratantes. No log aparece
`falha ao notificar ... nova tentativa em 60s`; três tentativas e ele
desiste, registrando. O pagamento segue confirmado do nosso lado: o que
se perde é o aviso, e a conciliação (`API.md` §5.2) é o caminho de volta.

**Perdi o acesso ao `/admin`:**
- Barrado pelo Cloudflare Access → painel Zero Trust, com a conta
  Cloudflare. Não há dependência circular entre as duas camadas.
- O painel abre mas toda chamada dá erro de rede, ou o login responde
  "só abre pelo endereço protegido" → a sessão do Access (24 h) venceu no
  meio do uso, ou o painel foi aberto por um endereço que não é o do
  Access. **Recarregue `checkout.sancocore.com.br/admin`** — o Access pede
  o login de novo e a chamada seguinte leva o JWT novo.
- `503 "Não foi possível conferir o acesso administrativo"` → a API não
  conseguiu ler as chaves da equipe
  (`https://fancy-dawn-740a.cloudflareaccess.com/cdn-cgi/access/certs`).
  É fechado de propósito: não há interruptor que deixe passar. Confira se
  o endereço responde; se a equipe do Access mudou de nome, a constante
  `EQUIPE_ACCESS` em `src/utils/accessJwt.js` muda junto, em código.
- **Aplicativo do Access recriado** (apagado e feito de novo) → o `aud`
  muda, e a origem passa a recusar todo JWT com `401` (motivo `aud` no
  log). Leia o `aud` novo na API do Access e troque `AUD_DO_PAINEL` em
  `src/utils/accessJwt.js`. É constante e não variável de propósito: um
  `aud` trocado por configuração abriria o painel à política de outro
  aplicativo da equipe.
- Reverter o SEC-015 inteiro, se ele travar o painel sem saída: `git
  revert` do commit que o trouxe (§4) — o painel volta a chamar a API
  direto e a origem para de exigir o JWT. Os destinos novos do Access
  podem ficar: sem a função, `/api/admin` no Pages só dá 404.
- Usuário/senha recusados → gerar hash novo com
  `node scripts/gerar-hash-admin.js` (rodar na raiz do projeto) e trocar
  `CHECKOUT_ADMIN_PASS_HASH` no Northflank. Trocar a senha **invalida
  todas as sessões abertas**, por construção.

**Vazou segredo:** revogar, sempre. Nunca só apagar do histórico —
reescrever histórico não alcança clone, fork nem cache de quem já
baixou.

## 8.1 Incidente com dado pessoal

Isto é diferente de "o sistema caiu": aqui há prazo legal correndo, e o
relógio começa **no conhecimento do incidente**, não na correção dele.
Anotar a hora em que se soube é o primeiro ato, antes de qualquer
conserto.

**Assumir que todo incidente de confidencialidade aqui é comunicável.**
O checkout trata dado **financeiro** e **de autenticação** (`api_key` de
contratante, hash de senha do admin, CPF/CNPJ, e-mail), e essas são
exatamente as categorias que tornam o risco "relevante" na Resolução
CD/ANPD nº 15/2024. Não gastar tempo discutindo se comunica.

**1. Quem decide:** o dono, como controlador. **Não há encarregado
indicado** — pequeno porte é dispensado, com a contrapartida de manter
canal publicado ao titular, que é o `juridico@sancocore.com.br` do
rodapé. Indicar encarregado é ato formal escrito, e não foi feito.

**2. Como isolar,** na ordem que para o sangramento sem destruir prova:

1. **Revogar o que dá acesso**, não o que dá sintoma: `api_key` do
   contratante afetado (painel `/admin` → trocar chave), ou
   `SUPABASE_SERVICE_KEY` se o vazamento é do backend (§1.2), ou a senha
   do admin — que invalida todas as sessões abertas.
2. **Não apagar nada.** Log, linha de `erros`, evento de webhook e o
   histórico do repositório são a prova de extensão e de causa raiz, e a
   comunicação à ANPD exige as duas. Apagar para "limpar" é o erro que
   transforma incidente em incidente mal comunicado.
3. Só então corrigir o furo, e registrar a hora de cada passo.

**3. Como contar afetados.** A conta é por titular, não por linha, e o
titular aqui é identificado por `documento` — que desde 17/09/2026 é uma
chave só, em dígitos (RN-32), justamente para esta conta não sair
dobrada. As tabelas com dado pessoal estão em
`docs/inventario-de-dados.md` §6, e a mesma lista branca da rotina de
expurgo serve de mapa (`src/services/expurgoService.js`). Para o escopo
mais comum — um contratante comprometido:

```sql
select count(distinct documento) as titulares, count(*) as cobrancas
from cobrancas where contratante_id = '<id>';
```

Contar com `count(*)` em vez de `count(distinct documento)` infla o
número na comunicação, e número inflado depois corrigido é o que a ANPD
lê como "o controlador não sabia o que tinha".

**4. Quem escreve, e por onde.** O dono, pelo **peticionamento
eletrônico da ANPD**, com conta gov.br. Sem encarregado, assina o
próprio controlador (ou procurador com procuração assinada). **A conta
gov.br precisa existir e ter sido testada antes** — testar no dia do
incidente é perder o prazo. Está na lista de pré-lançamento da skill
`legal`, e é do dono.

**5. Os prazos.** Fonte: `san-co:legal`,
`references/obrigacoes-brasil.md` (LGPD art. 48; Resoluções CD/ANPD nº
15/2024, nº 2/2022), lido na fonte em 17/09/2026 — não de memória.

**Estes são os prazos a cumprir** — um só por linha, de propósito:

| o que | prazo |
|---|---|
| comunicar à **ANPD** | **3 dias úteis** do conhecimento |
| comunicar aos **titulares** | **3 dias úteis**, em linguagem simples e individualizada (e-mail serve) |
| **complementar** o que faltava | **20 dias úteis** |
| confirmação e acesso ao titular, formato simplificado | **imediatamente** |
| declaração completa ao titular | **15 dias** |

> **Existe um regime de prazo em dobro, e ele NÃO se aplica aqui até
> alguém provar que se aplica.** A tabela acima tinha uma segunda coluna
> com os prazos dobrados (6 dias úteis, 30 dias) e um aviso logo abaixo
> mandando não usá-la — publicar um número que não se deve usar é como
> o número errado acaba usado sob pressão, e por isso ele saiu da
> tabela. O regime flexibilizado é autoenquadramento de ME, EPP e
> startup; este projeto está **pessoa física, em transição**
> (`CONSTRAINTS.md` §3). Assumir o dobro e estar errado é perder prazo
> legal, e prazo perdido não volta; assumir o curto e estar errado não
> custa nada. Quem muda isto é a validação jurídica da Estação 7, por
> escrito.

Se a comunicação individual ao titular for inviável, o substituto é
aviso no site por **no mínimo três meses**.

**6. O que a comunicação precisa dizer** (ANPD e titulares, o mesmo
conteúdo, linguagem diferente): natureza dos dados; número de titulares
afetados; medidas de segurança antes e depois; riscos; motivo de
eventual demora; mitigação; **data do incidente e data do
conhecimento**; identificação do controlador, com a declaração de
pequeno porte se ela se aplicar; identificação do operador (aqui:
Asaas, Supabase, Northflank, Cloudflare, Google); descrição e causa
raiz. Pode-se comunicar preliminarmente e completar depois — o que não
se pode é deixar o prazo passar em silêncio.


## 9. Dependências externas, e o que quebra se cada uma cair

Nenhuma delas é nossa, e cada uma derruba uma coisa diferente. A coluna
que importa é a última.

| se cair | o que para | o que continua | como perceber | o que fazer enquanto |
|---|---|---|---|---|
| **Asaas — API** | criar cobrança, estornar, cancelar assinatura | tela, banco, cobrança já criada | tela do comprador erra ao gerar; `/api/saude` acusa a chave | esperar; nada a conciliar, porque nada nasceu |
| **Asaas — webhook** | a **confirmação** de pagamento | o pagamento em si, que acontece de qualquer jeito | aba Webhook vazia, pedido pago e `pendente` | conciliar (`API.md` §5.2 e §5.3); é o caminho de volta, e ele existe |
| **Supabase** | tudo | nada | `/api/saude` 503 | §6; RTO medido de 1 s para restaurar noutro Postgres, **mas sem cópia externa hoje** (exceção §3) |
| **Northflank** | a API inteira | as telas (Cloudflare Pages) continuam servindo — e isso é pior que cair junto: o comprador vê a página e ela não funciona | `/api/saude` sem resposta | §4 (reverter) só resolve se a causa é o nosso commit |
| **Cloudflare — DNS** | `api.` e `checkout.` deixam de resolver | nada | nada resolve, de nenhum lugar | é a única dependência sem plano B: o registro aponta para lá |
| **Cloudflare — Access** | o `/admin` e a API do admin (a origem confere o JWT dele, e com as chaves fora do ar responde `503`) | o checkout do comprador, inteiro | login do admin não abre | por desenho: falha fechada. Painel Zero Trust, sem dependência circular |
| **Cloudflare — Pages** | as telas do comprador | a API — contratante integrado por API sente menos | página não carrega | o link de cobrança fica inútil até voltar |
| **Google Workspace** | `juridico@` e `suporte@` | o sistema | e-mail devolvido | **é canal legal do titular** (LGPD): indisponibilidade prolongada é problema de conformidade, não só de suporte |
| **registro.br** | o domínio, e com ele tudo | nada | ninguém avisa — é o motivo da data em §1.1 | **31/08/2027**; renovar antes |
| **cron-job.org** | o ping que mantém o Supabase acordado | tudo | primeira requisição do dia lenta | nada urgente — e **não está confirmado que ele existe hoje**, ver §2 |
| **GitHub** | publicar versão nova | o que está no ar | push falha | o ar não depende do GitHub depois do deploy |
| **npm / registro de imagem** | o build | o que está no ar | build vermelho | não forçar deploy; o ar está bom |

## 10. Contatos

| quem | para que | como |
|---|---|---|
| **o dono** (Bruno) | tudo que é decisão: dinheiro, DNS, segredo, legal | ⬜ telefone/e-mail direto |
| **pessoa número dois** | operar sem o dono: deploy, reversão, ler este arquivo | ⬜ **não existe hoje** — e é o teste que fecha o item 6 da prontidão |
| titular de dado (LGPD) | acesso, correção, exclusão | `juridico@sancocore.com.br` — publicado no rodapé e nos documentos legais |
| problema na página | comprador | `suporte@sancocore.com.br` |
| Asaas | fila pausada, chave, conta | painel → suporte; o e-mail de falha de webhook é do mesmo canal |
| Supabase, Northflank, Cloudflare | conta e infraestrutura | suporte pelo painel de cada um (⬜ plano contratado define se há resposta com prazo) |

**A pessoa número dois é o item aberto, e a prontidão operacional é
explícita sobre como fechá-lo:** ela, com este arquivo e sem falar com
quem construiu, faz um deploy trivial, reverte, e acha a data de
vencimento do domínio. Onde ela travar, este arquivo está incompleto.
Uma vez por semestre basta.

### O teste já foi rodado uma vez, por um substituto — 17/09/2026

Pessoa número dois não existe ainda, então o teste foi rodado por um
**agente sem nenhum contexto desta sessão**, autorizado a ler **só este
arquivo** e proibido de executar qualquer ação de escrita. Não é a mesma
coisa que uma pessoa (ele não tem as credenciais, e a metade "publique
de verdade" ficou fora), mas mede exatamente o que interessa: **o
arquivo ensina, ou não?**

O que ele conseguiu sozinho: dizer que o sistema está no ar e onde roda
(conferindo de fora que a API não passa pelo Cloudflare e o front
passa), e achar o vencimento do domínio — **31/08/2027**, pelo comando
do §1.1, na primeira tentativa.

O que ele **não** conseguiu, e virou correção neste arquivo no mesmo dia:

| o que travou | onde estava o furo | como ficou |
|---|---|---|
| publicar uma mudança | §3 dizia "`git push` na `main`" e não existia caminho de uma branch de trabalho até a `main`, nem aviso de que o fluxo real é por PR | §3 tem o caminho inteiro, com `git fetch`, a branch, o `npm run check` e o PR |
| saber **qual versão está no ar** | nenhuma seção respondia, e a §4 pedia `git revert <sha-ruim>` | §3 tem o comando do `deployedSHA`, conferido |
| ver se o CI ficou verde | §3 chamava o CI de "a porta" e não dizia onde olhar; o `gh` não está instalado | §3 traz a URL do Actions e diz que não há comando local |
| restaurar o banco | §6 mandava aplicar as migrations `0001 … 0006`; existem **nove** | §6 manda listar o diretório e explica o que faltaria |
| auditar as variáveis | o comando "seguro" do §1.2 listava **10 de 11** e comia a `ASAAS_AMBIENTE` — a variável da troca para produção | §1.2 lê o JSON e devolve as 11 |
| conferir a URL do webhook | §6.2 dizia "o plural dá 401, o singular 404" sem o método; com `GET` **os dois dão 404** | §6.2 tem a matriz dos quatro casos e o `POST` |
| entender o alerta que existe | §2 ensinava a montar dois monitores (plano de 14/09) e a §6.3 dizia que não existe alerta (decisão de 17/09) | o tutorial saiu para `docs/proximas-versoes.md`; §2 diz o que existe |
| — | §4 proibia `git reset --force`, **que não existe como comando** | §4 nomeia `git push --force` e `git reset --hard` |

Quatro desses oito teriam **consequência real** se alguém os seguisse:
as migrations, a lista de variáveis, a conferência do webhook e a
reversão sem saber o sha. Nenhum deles aparecia na §12 ("o que este
runbook ainda não tem") — o que é a lição do teste: **a lista de
lacunas escrita por quem escreveu o arquivo não enxerga as lacunas que
travam quem o lê**.

Repetir o teste é barato, e a regra passa a ser: **depois de qualquer
edição grande neste arquivo, rodar um leitor sem contexto** — pessoa,
quando houver; agente, enquanto não houver.

## 11. Desligar tudo com segurança

A ordem é o conteúdo desta seção. Invertida, alguém paga e ninguém
confirma.

1. **Parar de nascer cobrança nova.** Arquivar os contratantes no painel
   `/admin` — o cadastro e o histórico ficam, e o link antigo para de
   cobrar. Não apagar contratante: `CONSTRAINTS.md` §1.10 veta exclusão
   física, e o caminho é arquivar.
2. **Encerrar o que ainda cobra sozinho:** cancelar as assinaturas
   ativas (`API.md` §7.4). Assinatura viva depois do desligamento cobra
   o comprador sem ninguém do outro lado — é o pior desfecho possível.
3. **Esperar as cobranças pendentes resolverem** (Pix e boleto vencem
   sozinhos) e **conciliar** (`API.md` §5.2 e §5.3). Aqui o receptor de
   webhook ainda precisa estar de pé: desligá-lo antes deste passo é
   pagamento entrando e não sendo confirmado — e 15 falhas pausam a fila
   da conta.
4. **Só então desativar o webhook** no painel da Asaas. Deixá-lo
   apontando para um serviço morto acumula falha (§2.3 do
   `CONSTRAINTS.md`), e foi exatamente isso que gerou a penalidade de
   17/09/2026 com a URL antiga do Render.
5. **Exportar o banco e guardar a cópia fora do provedor**, conferida
   por restauração (§6 diz como, e o ensaio é a conferência). A guarda
   fiscal de 5 anos não deixa simplesmente apagar (Lei 10, RN-31), e o
   dado de cobrança é o que se precisa ter para responder a titular e a
   fisco depois de tudo desligado.
6. **Desligar a infraestrutura**, nesta ordem: escalar o serviço do
   Northflank para zero instância; pausar o projeto Supabase; manter a
   zona do Cloudflare e o **domínio ativo** enquanto houver contrato ou
   prazo legal correndo — domínio expirado é e-mail do titular voltando,
   o que é descumprimento, não economia.
7. **Nunca apagar o projeto Supabase antes de o dump ter sido
   restaurado com sucesso em outro lugar.** Backup não conferido não é
   backup, e aqui não há cópia externa automática (exceção §3).

## 12. O que este runbook ainda não tem

Lista reescrita em 17/09/2026, quando as seções 1.1, 1.2, 6.3, 8.1, 9,
10 e 11 foram escritas. Três itens que estavam aqui **saíram porque
foram feitos ou decididos**, não porque envelheceram: a captura de
exceção existe (migration 0007, aba Erros, §6.1), e o alerta externo de
queda e o alerta de orçamento viraram decisão do dono em 17/09 —
`CONSTRAINTS.md` §3 e `docs/pendencias.md`.

O que falta de verdade:

- **os campos `⬜` das seções 1.1 e 10** — e-mail de login de cada
  conta, onde senha e segundo fator moram, qual cartão paga o quê, e o
  contato direto do dono. Só ele preenche, e sem isso as duas seções
  descrevem a forma sem servir na hora;
- **a pessoa número dois**, que é ao mesmo tempo o contato que falta e o
  teste que fecha o item 6 da prontidão (§10);
- **SPF na zona** `sancocore.com.br` (§1.1): medido ausente, e com
  `p=reject` no DMARC isso é risco de rejeição, não de spam. Mudar DNS é
  do dono;
- **rotação sem janela do token de webhook** (§1.2): o código aceita um
  token por vez, e qualquer ordem de troca acumula falha;
- **cópia periódica** do banco fora do provedor — o *ensaio* de
  restauração existe e passou (§6); o que falta é o backup automático em
  si, e ele tem gatilho escrito (`CONSTRAINTS.md` §3);
- **monitor que avise quando a tarefa agendada não rodou**;
- **tempo de volta ao ar medido numa reversão real** — §4 descreve o
  caminho, e ninguém cronometrou;
- **se o ping externo de 10 minutos existe** (§2): a §1 diz
  `cron-job.org`, e um texto de 14/09 dizia que ele havia caído. Daqui
  não é verificável; quem sabe é o painel.

> **Esta lista não enxergava as duas lacunas que mais travavam quem
> lê.** Até 17/09/2026 ela não mencionava que não havia caminho escrito
> de publicação a partir de uma branch, nem forma de saber qual commit
> está no ar — as duas foram achadas pelo leitor sem contexto do §10,
> não por quem escreveu o arquivo, e as duas já estão cobertas na §3.
> A lição fica: **lacuna listada pelo autor é a lacuna que o autor
> conhece.** O resto sai do teste.
