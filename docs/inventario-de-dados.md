# Inventário de dados pessoais — San Checkout

Atualizado em 11/09/2026.

Regra de manutenção: **campo novo sem linha nova é tarefa incompleta.**
Este arquivo é a fonte dos Termos de Uso e da Política de Privacidade
(ver skill `legal`).

---

## 1. Comprador (titular terceiro — não é o operador)

Coletado na tela de pagamento, gravado na tabela `cobrancas`.

| Dado | Coluna | Para quê | Quem mais recebe |
|---|---|---|---|
| Nome ou razão social | — (só trafega) | Identificar o pagador na Asaas | Asaas |
| CPF ou CNPJ | `documento` | Exigência da Asaas para criar cobrança; conciliação | Asaas |
| E-mail | `email` | Identificar o cliente na Asaas; conciliação | Asaas |
| Telefone | `telefone` | Exigência da Asaas para Cartão/Assinatura | Asaas |
| Endereço: logradouro, número, complemento, bairro, CEP, cidade, UF, código IBGE | `endereco`, `endereco_numero`, `endereco_complemento`, `bairro`, `cep`, `cidade`, `uf`, `cidade_ibge` | Antifraude da Asaas — **só em Cartão e Assinatura por cartão**; Pix, boleto e Pix Automático não pedem | Asaas |
| Itens do pedido | `itens` | Exibição no resumo e conciliação | — |
| Valores, taxas, método, status | vários | Registro financeiro | Contratante (via webhook) |

**Não coletado, nunca:** número de cartão, CVV, validade, titular do
cartão. Esses dados são digitados numa pop-up hospedada pela Asaas e não
passam por este servidor nem pelo servidor do contratante.

**Origem alternativa:** o contratante pode pré-preencher nome, e-mail,
documento e telefone no `pagador` do `GET /pedido/{id}` — nesse caso o
dado vem dele, não do comprador digitando.

## 2. Assinante

Tabela `assinaturas`: `documento` (CPF/CNPJ), mais valor, ciclo e próxima
cobrança. É o par `plano_id` + `documento` que identifica o assinante nas
operações de cancelar, pausar, retomar e conciliar.

## 3. Titular de subconta Asaas

Tabela `subcontas`, preenchida pelo operador no painel administrativo ao
abrir uma subconta: `nome`, `email`, `documento`, `telefone`, `celular`,
`endereco`, `endereco_numero`, `complemento`, `bairro`, `cep`,
`faturamento`, `tipo_empresa`, `data_nascimento`. Enviados à Asaas em
`POST /v3/accounts`.

Guarda também `wallet_id`, `api_key` e `link_ativacao` da subconta —
credenciais, não dado pessoal, mas com o mesmo cuidado de exposição
(mascaradas na tela, reveladas só sob clique).

## 4. Operador

`CHECKOUT_ADMIN_USER` e `CHECKOUT_ADMIN_PASS` em variável de ambiente do
Render. Não há tabela de usuários e não há senha no banco.

---

## 5. Onde os dados ficam

| Onde | O quê | Observação |
|---|---|---|
| Supabase (Postgres) | Tudo das seções 1-3 | RLS habilitado nas quatro tabelas; só o backend acessa, com `service_role` |
| Asaas | Cliente, cobrança, assinatura, subconta | Operador de pagamento; sub-processador |
| Render | Logs da aplicação | Ver seção 7 |
| Cloudflare Pages | Nada — front estático | Não recebe dado pessoal em repouso |
| Contratante | Payload do webhook e da conciliação | Não inclui endereço; inclui `pedidoId`, valores e, em assinatura, `documento` |

## 6. Retenção e exclusão

> ⚠️ **PENDÊNCIA ABERTA — não definido.** Não existe política de
> retenção escrita nem rotina de expurgo. Hoje o dado fica
> indefinidamente no Supabase e na Asaas. Exclusão a pedido do titular
> (LGPD art. 18) é manual, sem mecanismo estruturado.
>
> Isto está registrado como pendência em `CLAUDE.md` e precisa ser
> fechado antes do lançamento — é entrada obrigatória da Política de
> Privacidade.

## 7. Log

O backend registra o payload cru dos webhooks da Asaas
(`console.log` em `webhookController.js`). Esse payload **contém dado
pessoal do comprador**. Não contém dado de cartão.

> ⚠️ **PENDÊNCIA ABERTA.** Log de produção com dado pessoal em texto
> puro, retido pelo Render. Avaliar reduzir para os campos necessários ao
> diagnóstico assim que o formato dos eventos estiver confirmado ao vivo
> — o log completo existe justamente porque o formato ainda não foi
> confirmado.
