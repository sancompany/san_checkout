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

**NÃO HÁ BACKUP AUTOMÁTICO.** O plano gratuito do Supabase não faz, e
isso é exceção registrada com gatilho no `CONSTRAINTS.md` (Lei 6): o
gatilho é a primeira cobrança real. Enquanto o banco só tem dado de
teste, o custo de perdê-lo é reescrever o schema a partir de
`supabase/migrations/`.

Reconstruir do zero: aplicar `supabase/migrations/0001` a `0003`, na
ordem, pelo editor SQL do Supabase.

**Restauração nunca foi exercitada.** Enquanto não for, é backup
hipotético — e é isso que a Lei 6 chama de não conforme.

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

## 9. O que este runbook ainda não tem

Entra na Estação 6 (prontidão operacional), e está em
`docs/pendencias.md`:

- alerta externo de "caiu" que chegue ao celular;
- captura de exceção com contexto da requisição;
- monitor que avise quando a tarefa agendada **não** rodou;
- alerta de orçamento nas contas pagas;
- teste de restauração do banco;
- tempo de volta ao ar medido numa reversão real;
- leitura deste arquivo por uma segunda pessoa, que é o teste de que ele
  serve.
