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

### Passo 2 — desativar o webhook do SANDBOX

No painel de sandbox, desativar (ou apagar) o webhook atual. Se ficar
ligado, ele passa a acumular 401 — e depois de 15 falhas seguidas a
Asaas **pausa a fila** daquela conta (§2.3). Não afeta produção, mas
deixa o sandbox inutilizável para o próximo teste.

### Passo 3 — limpar os registros de teste

```bash
npm run limpar-teste          # mostra o que apagaria, não apaga
npm run limpar-teste -- --apagar --confirmo-que-e-sandbox
```

A segunda bandeira não é burocracia. O script **não tem como saber** se
o banco já tem dinheiro real: `ASAAS_AMBIENTE` vive no contêiner e
nenhuma coluna marca "esta cobrança é real". Em vez de fingir um guarda,
ele exige que você afirme — e recusa com código 1 se a bandeira faltar.
Confira a lista que ele imprime antes de confirmar.

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

## 9. O que este runbook ainda não tem

Entra na Estação 6 (prontidão operacional), e está em
`docs/pendencias.md`:

- alerta externo de "caiu" que chegue ao celular;
- captura de exceção com contexto da requisição;
- monitor que avise quando a tarefa agendada **não** rodou;
- alerta de orçamento nas contas pagas;
- **cópia periódica** do banco fora do provedor (o *ensaio* de restauração
  já existe e passou — §6; o que falta é o backup automático em si);
- tempo de volta ao ar medido numa reversão real;
- leitura deste arquivo por uma segunda pessoa, que é o teste de que ele
  serve.
