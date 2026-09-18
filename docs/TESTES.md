# San Checkout — como testar (local, sem gastar nada)

Guia de copiar-e-colar do teste MANUAL, no navegador e no terminal. Todo
comando é PowerShell (`curl.exe`, não o `curl`/`Invoke-WebRequest` padrão
do PowerShell — evita problema de aspas). Rode cada bloco na ordem.

> **Isto não é a suíte automática.** Os testes que rodam sozinhos são
> `npm test` (as suítes) e `npm run check` (análise de sintaxe de todo
> JS, inclusive `public/js/`, e depois as suítes) — ver o `README.md`.
> Este guia é para exercitar o fluxo do comprador à mão, que é o que
> nenhuma suíte alcança.
>
> Os caminhos abaixo dizem `D:\san-checkout-v2` porque o guia nasceu na
> máquina do dono; em qualquer outro lugar, é a raiz do repositório.

## 0. Preparar (uma vez só)

```powershell
cd D:\san-checkout-v2
npm install
```

No `.env` (não no `.env.example`), preencha pelo menos:
- `ASAAS_API_KEY` — chave do **sandbox** da Asaas (sem ela, os passos 3 e 5 abaixo falham com erro 502)
- `SUPABASE_URL` e `SUPABASE_SERVICE_KEY`
- `CHECKOUT_ADMIN_USER` e `CHECKOUT_ADMIN_PASS_HASH` — a senha do admin
  não é guardada em texto: o que vai no `.env` é o hash scrypt, gerado
  por `node scripts/gerar-hash-admin.js` (não existe atalho de `npm run`
  para ele). Ele **pergunta a senha no prompt** e não a ecoa na tela nem
  no histórico — então roda no terminal, não em script

A lista completa é o `.env.example`, que é a fonte: ele tem onze
variáveis, e nenhuma a mais.

> ⚠️ Este parágrafo dizia, até 18/09/2026, que `SMTP_*` e `GOOGLE_*`
> podiam ficar em branco "pros testes" porque sem eles "o e-mail de
> confirmação e o arquivamento de nota fiscal só são pulados". **As três
> coisas são falsas**: as variáveis não existem mais no `.env.example`, e
> e-mail ao comprador e nota fiscal foram **removidos do escopo em
> 08/09/2026** (`CONSTRAINTS.md` §1.9). Documento que promete recurso
> removido faz quem lê procurar defeito onde há decisão.

## 1. Subir os dois servidores

Precisa de **duas janelas do PowerShell abertas ao mesmo tempo**.

Janela A — mock (finge ser o site do cliente, ex.: Trimundi):
```powershell
cd D:\san-checkout-v2
node tests/servidor-mock-pedido.js
```

Janela B — o San Checkout de verdade:
```powershell
cd D:\san-checkout-v2
npm start
```

Deixe as duas abertas — os logs que aparecem nelas são como você
confere se cada passo abaixo funcionou.

## 2. Cadastrar um contratante de teste

Abra `http://localhost:3001/admin.html` no navegador. Entre com o
`CHECKOUT_ADMIN_USER`/`CHECKOUT_ADMIN_PASS` do `.env`. Cadastre:

| Campo | Valor |
|---|---|
| id | `teste1` |
| nome | `Contratante de Teste` |
| apiBaseUrl | `http://localhost:4000` |
| webhookUrl | `http://localhost:4000/webhook` |
| walletId | (deixe em branco) |

Depois de cadastrar, **copie o `api_key`** que aparece na tabela —
vai ser usado como `<API_KEY>` nos comandos abaixo.

## 3. Pix (o que já está de pé)

```powershell
curl.exe -X POST http://localhost:3001/api/checkout/pix/teste1/pedido-1 -H "Content-Type: application/json" -d '{"nome":"Fulano","email":"fulano@teste.com","documento":"12345678900"}'
```

Esperado: JSON com `chargeId`, `qrCodeBase64`, `copiaECola`. **Copie o
`chargeId`** retornado — usado no passo 4.

Se der erro 502 aqui, o `ASAAS_API_KEY` do `.env` está errado/ausente
— resolve isso antes de continuar, os outros métodos dependem da
mesma chave.

## 4. Simular a confirmação do Pix (sem esperar pagar de verdade)

```powershell
curl.exe -X POST http://localhost:3001/api/webhooks/asaas -H "Content-Type: application/json" -d '{"event":"PAYMENT_CONFIRMED","payment":{"id":"<CHARGE_ID_DO_PASSO_3>"}}'
```

Troque `<CHARGE_ID_DO_PASSO_3>` pelo valor copiado. Confira na
**Janela A** — deve aparecer `[mock] webhook recebido` com
`status: "confirmado"`. Se o SMTP estiver configurado, um e-mail
também deveria chegar em `fulano@teste.com` (troque pra um e-mail seu
no passo 3 se quiser ver isso de verdade).

## 5. Boleto + estorno assíncrono

Criar o boleto:
```powershell
curl.exe -X POST http://localhost:3001/api/checkout/boleto/teste1/pedido-2 -H "Content-Type: application/json" -d '{"nome":"Fulano","email":"fulano@teste.com","documento":"12345678900"}'
```
Copie o `chargeId` retornado.

Estornar (usa o `api_key` do passo 2, não o do Asaas):
```powershell
curl.exe -X POST http://localhost:3001/api/checkout/estornar -H "Content-Type: application/json" -H "X-Checkout-Key: <API_KEY>" -d '{"pedidoId":"pedido-2"}'
```
Esperado: `"status":"estorno_solicitado"` — **não** `"estornado"`
ainda. Isso é o comportamento correto do Boleto (assíncrono), não é
bug.

Simular a Asaas confirmando o estorno de verdade:
```powershell
curl.exe -X POST http://localhost:3001/api/webhooks/asaas -H "Content-Type: application/json" -d '{"event":"PAYMENT_REFUNDED","payment":{"id":"<CHARGE_ID_DO_BOLETO>"}}'
```

## 6. Assinatura (só a parte que dá pra testar sem cartão real)

O checkout de Cartão/Assinatura usa pop-up da própria Asaas — não dá
pra simular digitando cartão por curl. Mas dá pra confirmar que a
consulta de plano e o cancelamento funcionam:

```powershell
curl.exe http://localhost:3001/api/checkout/plano/teste1/plano-1
```
Esperado: o plano fixo que vem do mock (Janela A mostra
`[mock] plano solicitado`).

```powershell
curl.exe -X POST http://localhost:3001/api/checkout/cancelar-assinatura -H "Content-Type: application/json" -H "X-Checkout-Key: <API_KEY>" -d '{"planoId":"plano-1","documento":"12345678900"}'
```
Esperado: erro 404 "Nenhuma assinatura ativa encontrada" — é o
esperado (não existe assinatura real ainda), só confirma que a rota e
a autenticação funcionam.

## 7. Saúde geral

```powershell
curl.exe http://localhost:3001/api/saude
```
Esperado: `supabaseRespondendo: true`, `chaveAsaasConfigurada: true`.

## 8. `returnUrl` — o caminho de volta, e o open redirect

O checkout honra `?returnUrl=` **só** se a origem do destino pertencer
ao contratante (`API.md` §3.1). Quem decide é o backend, então dá para
conferir a regra inteira sem abrir o navegador: a resposta de
`GET /api/checkout/pedido/…` traz `retornoUrl` com o destino aprovado,
ou `null`.

**Comece pelos dois controles positivos.** Sem eles o teste não vale
nada — se a requisição estiver falhando por outro motivo (chave errada,
pedido inexistente), TODA carga volta `null` e o resultado parece
defesa perfeita quando é só erro. Aconteceu em 15/09/2026.

```powershell
# DEVE aceitar — a origem do apiBaseUrl vale sempre, sem cadastrar nada
curl.exe "http://localhost:3001/api/checkout/pedido/teste1/ped_completo?returnUrl=http%3A%2F%2Flocalhost%3A4000%2Fobrigado"
```

> Em ambiente local a origem `http://localhost` é recusada de propósito
> (`alvoDeRedeSeguro` exige https e host público), então este controle
> só devolve destino contra um contratante de `apiBaseUrl` https real —
> use o `testemaster`, cujo worker é público.

Com o contratante certo, o esperado é `retornoUrl` terminando em
`?pedido=<id>` — **e nada além disso**. Se aparecer `status`, `pago` ou
equivalente, é furo: a barra de endereço passaria a "provar" pagamento.

**Agora as cargas hostis.** Todas devem devolver `retornoUrl: null`:

| carga | o que ela fura se passar |
|---|---|
| `https://golpe.tld` | nada — é o caso óbvio |
| `https://SEU-DOMINIO.com.br.golpe.tld` | comparação com `endsWith` |
| `https://golpe.tld/?v=https://SEU-DOMINIO.com.br` | comparação com `includes` |
| `https://golpe.tld#https://SEU-DOMINIO.com.br` | comparação com `includes` |
| `https://SEU-DOMINIO.com.br@golpe.tld` | leitura humana da barra de endereço |
| `https:/\golpe.tld` | `split('/')[2]` |
| `javascript:alert(1)` | qualquer coisa que não cheque o esquema |
| `http://SEU-DOMINIO.com.br` | a chave viajando em claro |
| `https://169.254.169.254/` | metadata da nuvem (SSRF) |

Codifique o valor antes de pôr na query (`encodeURIComponent`).

**O que NÃO é furo:** CR/LF no meio do valor voltar aceito, desde que
saneado. O parser do WHATWG remove esses bytes e devolvemos o objeto
re-serializado — confira que a saída não tem CR, LF nem TAB e que a
origem continua sendo a autorizada. Isso está coberto por
`npm test` (`retornoSeguro` e `retorno-nao-vira-open-redirect`).

---

**Erros que você PODE ignorar nesses testes:** qualquer aviso de
e-mail/Drive não configurado. **Erros que significam algo quebrado:**
qualquer 500/502 nos passos 3–7, ou o webhook da Janela A nunca
aparecer depois dos passos 4/5.
