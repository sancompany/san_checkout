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
| Porta do `/admin` | Cloudflare Access, equipe `fancy-dawn-740a` | política "Somente o operador" |
| Repositório | GitHub `sancompany/san_checkout`, branch `main` | — |
| Ping externo | cron-job.org, a cada 10 min em `/api/saude` | mantém Supabase ativo |

Aplicação e banco na mesma região — medido em 13/09/2026 do navegador do
operador: rota sem banco 20-29 ms, rota com uma consulta 70-295 ms.

## 1.1 Inventário de contas

**Por que esta seção existe:** quem construiu tem tudo na cabeça até o
dia em que o cartão do registrador expira e o domínio cai. A tabela
abaixo é para outra pessoa conseguir operar sem falar com quem
construiu.

O que a sessão **mediu** em 17/09/2026 está escrito; o que **só o dono
sabe** está marcado `⬜` e continua pendência até ele preencher —
inventar aqui seria pior que deixar em branco.

| conta | para que | identificadores medidos | login | senha e 2º fator | renovação / quem paga |
|---|---|---|---|---|---|
| **registro.br** | domínio `sancocore.com.br` | registrado 31/08/2026, **vence 31/08/2027** (RDAP, medido) | ⬜ | ⬜ | **31/08/2027** · cartão ⬜ |
| **Cloudflare** | DNS da zona, Pages (`san-checkout`), Access (equipe `fancy-dawn-740a`) | zona `sancocore.com.br` | ⬜ | ⬜ | plano ⬜ · cartão ⬜ |
| **Northflank** | backend | projeto/serviço `san-checkout`, branch `main`, build `nf-compute-400-16`, runtime `nf-compute-50` | ⬜ | ⬜ | mensal ⬜ · cartão ⬜ |
| **Supabase** | banco | org `fphbzkrzgijqzpqzvshh`, projeto `San_Checkout` ref `zacuaroarelaqnzjjlcz`, `sa-east-1`, Postgres 17.6 | ⬜ | ⬜ | plano ⬜ · cartão ⬜ |
| **Asaas** | pagamento | conta **pessoa física, em transição** (`CONSTRAINTS.md` §3); hoje `sandbox` | ⬜ | ⬜ | tarifa por transação · sem mensalidade conhecida ⬜ |
| **GitHub** | repositório e CI | `sancompany/san_checkout`; **os dois workflows não usam segredo de repositório** (medido) | ⬜ | ⬜ | plano ⬜ |
| **Google Workspace** | e-mail `@sancocore.com.br` | MX `smtp.google.com`, DKIM seletor `google`, DMARC `p=reject` — **sem registro SPF** (medido em dois resolvedores) | ⬜ | ⬜ | por caixa ⬜ · cartão ⬜ |
| **cron-job.org** | ping de 10 min em `/api/saude` | mantém o Supabase acordado | ⬜ | ⬜ | gratuito ⬜ |

**Como reconferir o vencimento do domínio** (é o item que mais cai, e o
único aqui que ninguém avisa):

```bash
curl -s https://rdap.registro.br/domain/sancocore.com.br \
  | python3 -c "import sys,json;[print(e['eventAction'],e['eventDate']) for e in json.load(sys.stdin)['events']]"
```

**O SPF ausente é achado, não detalhe.** Com DKIM e `p=reject`, o
e-mail enviado pelo Google passa por alinhamento de DKIM — e foi por
isso que a conferência do item 1 da prontidão deu "chega". Mas
receptor que pesa SPF vê `none`, e qualquer caminho futuro que quebre a
assinatura DKIM (encaminhamento, provedor transacional novo) é
**rejeitado**, não classificado como spam. A correção é um registro TXT
na zona — e mudar DNS é da lista curta, então é do dono
(`docs/pendencias.md`).

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
> northflank get service --project san-checkout --service san-checkout \
>   | grep -oE '^ +[A-Z][A-Z0-9_]+:' | sort -u
> ```

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

**Alerta de queda (Lei 8) — dois monitores, um cobre o cego do outro.**
Decisão do dono 14/09: um externo (pega queda total da plataforma) e um
interno no Northflank (pega o resto, mais barato e robusto). O sinal já
existe: `/api/saude` → `200 ok` / `503 degradado` / sem resposta.

**INTERNO — Northflank** (`app.northflank.com/s/account/integrations/notifications`):
1. **Integração:** Create → Slack ou Discord → autorizar → escolher o
   canal (push no celular). Em "handle events only from specific
   projects", marcar `san-checkout`.
2. **Infrastructure alerts:** na página de alertas da conta, ligar
   container crashed / high CPU / high memory / volume low → roteadas
   para a integração. Cobre app caído / OOM / deploy ruim, sem job.
3. **Cron Job para o banco fora** (o `503`, que o infra alert não vê):
   projeto `san-checkout` → aba Jobs → Create → Cron.
   - schedule: `*/5 * * * *` · plano `nf-compute-10` · concurrency Forbid
   - imagem: `curlimages/curl:latest`
   - secret do job `ALERTA_WEBHOOK` = a URL do webhook do canal (Discord:
     Server Settings → Integrations → Webhooks → New; Slack: app de
     Incoming Webhooks)
   - comando (Discord usa `content`, Slack usa `text`):
     `sh -c 'curl -fsS -o /dev/null https://api.sancocore.com.br/api/saude || curl -fsS -X POST -H "Content-Type: application/json" -d "{\"content\":\"San Checkout: /api/saude nao-2xx\"}" "$ALERTA_WEBHOOK"'`
   - o `-f` faz o curl sair !=0 em HTTP ≥400 (o 503 dispara o POST). O job
     sai 0 no caminho feliz, sem ruído.

**EXTERNO — UptimeRobot** (trocar o cron-job.org que caiu):
1. Conta grátis → Add New Monitor → HTTP(s) →
   `https://api.sancocore.com.br/api/saude` → intervalo 5 min.
2. Keyword monitor: alertar quando **faltar** `"status":"ok"` no corpo —
   pega o 503, o degradado e o fora-do-ar de uma vez.
3. Alert Contacts: e-mail + app UptimeRobot no celular (push), associados
   ao monitor.

**Ponto cego que sobra:** os dois juntos cobrem app/banco/deploy e queda
total da plataforma. A detecção de "fila do webhook pausada" fica para
quando houver tráfego real — hoje, volume zero, qualquer limiar de
silêncio dá alarme falso (`docs/proximas-versoes.md`).

## 3. Publicar

`git push` na `main` publica nos dois lugares, sozinho: Northflank
(CI+CD do GitHub) e Cloudflare Pages.

**A porta é o CI verde, não uma pessoa.** Dois workflows:
`testes` (`npm test`) e `Segurança` (dependências, segredos, análise
estática).

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

**Nunca `git reset --force` na `main`.** Este repositório já perdeu
trabalho uma vez por reescrita de histórico
(`docs/erros/2026-09-11-filter-repo-apagou-trabalho-nao-commitado.md`).

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
webhook de entrada) — não uma camada de borda. Fechar a API atrás do
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

# 2. schema, na ordem, pelo editor SQL do Supabase ou psql:
#    supabase/migrations/0001 … 0006
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
2. **Painel `/admin` → aba Webhook.** Se o sintoma é "o contratante não
   foi avisado" ou "o pedido ficou pendente", o evento da Asaas está
   aqui — inclusive o que o código ainda não trata.
3. **`GET /api/saude`.** Diz se banco e chave da Asaas estão de pé, e
   traz o alerta de chave prestes a expirar.
4. **Log do Northflank.** Retenção curta, e é o único lugar com 4xx e
   com o que aconteceu antes do erro. Último recurso, não o primeiro.

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

   **Plural em `webhooks`.** Conferido ao vivo em 17/09: o plural
   responde 401 (guarda de token funcionando) e o singular responde
   **404**. Errar isto significa nenhuma cobrança confirmada, sem aviso.

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
npm run limpar-teste          # mostra o que apagaria, não apaga
npm run limpar-teste -- --apagar --confirmo-que-e-sandbox
```

O script tem **dois guardas, nessa ordem**. O primeiro é automático e
não tem como ser contornado: desde a migration 0009, `cobrancas.ambiente`
diz de onde cada cobrança veio (RN-33), e havendo **uma** linha de
produção ele recusa apagar qualquer coisa, inclusive com as duas
bandeiras. O segundo é a bandeira `--confirmo-que-e-sandbox`, que
continua exigida porque as outras quatro tabelas não têm a coluna e
apagar histórico de cobrança não tem volta.

Até 17/09/2026 só existia o segundo, e este parágrafo dizia que o script
"não tem como saber" — era verdade enquanto nenhuma coluna marcasse a
origem. Ele imprime a quebra por ambiente antes de perguntar qualquer
coisa; confira essa lista e a das assinaturas antes de confirmar.

**Antes da troca, não depois.** O motivo está no `API.md §11.1`:
assinatura de sandbox que sobrevive no nosso registro vira zumbi —
`/cancelar-assinatura` chama a Asaas de produção com um id de sandbox,
leva 404, e a linha que gravaria o status novo nunca roda. O registro
fica `ativa` para sempre, incancelável pela API.

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
<summary>Os 53 eventos, para conferir no painel (medidos em 17/09/2026)</summary>

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
PAYMENT_APPROVED_BY_RISK_ANALYSIS
PAYMENT_AWAITING_CHARGEBACK_REVERSAL
PAYMENT_AWAITING_RISK_ANALYSIS
PAYMENT_CHARGEBACK_REQUESTED
PAYMENT_CHECKOUT_VIEWED
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
| `/api/saude` devolvendo 503 | curl, ou o ping de 10 min do cron-job.org | banco inalcançável | §6.1, item 3 e 4; se for o Supabase, §6 (restaurar) só depois de confirmar que não é rede |
| aba **Erros** do painel crescendo | captura de exceção (migration 0007) | 5xx acontecendo agora | `ocorrencias` + `ultima_vez` dizem se é rajada; §6.1 |
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
3. Conciliar o que passou: `API.md` §5.2 (pedido) e §5.3 (assinatura).
   As duas rotas reconsultam a Asaas e corrigem o banco — enxergam
   pagamento que o webhook perdeu.

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

| o que | prazo | dobrado para pequeno porte |
|---|---|---|
| comunicar à **ANPD** | **3 dias úteis** do conhecimento | 6 dias úteis |
| comunicar aos **titulares** | **3 dias úteis**, em linguagem simples e individualizada (e-mail serve) | 6 dias úteis |
| **complementar** o que faltava | **20 dias úteis** | — |
| confirmação e acesso ao titular, formato simplificado | **imediatamente** | — |
| declaração completa ao titular | **15 dias** | 30 dias |

> **Usar a coluna do meio, não a dobrada** — até que a validação
> jurídica da Estação 7 diga o contrário. O regime flexibilizado é
> autoenquadramento de ME, EPP e startup, e este projeto está
> **pessoa física, em transição** (`CONSTRAINTS.md` §3): assumir o dobro
> e estar errado é perder prazo legal, e prazo perdido não volta.
> Assumir o curto e estar errado não custa nada.

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
| **Cloudflare — Access** | o `/admin` | o checkout do comprador, inteiro | login do admin não abre | por desenho: falha fechada. Painel Zero Trust, sem dependência circular |
| **Cloudflare — Pages** | as telas do comprador | a API — contratante integrado por API sente menos | página não carrega | o link de cobrança fica inútil até voltar |
| **Google Workspace** | `juridico@` e `suporte@` | o sistema | e-mail devolvido | **é canal legal do titular** (LGPD): indisponibilidade prolongada é problema de conformidade, não só de suporte |
| **registro.br** | o domínio, e com ele tudo | nada | ninguém avisa — é o motivo da data em §1.1 | **31/08/2027**; renovar antes |
| **cron-job.org** | o ping que mantém o Supabase acordado | tudo | primeira requisição do dia lenta | nada urgente |
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
  caminho, e ninguém cronometrou.
