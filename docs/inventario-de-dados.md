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

`CHECKOUT_ADMIN_USER` e `CHECKOUT_ADMIN_PASS_HASH` em variável de
ambiente do Render. Não há tabela de usuários, não há senha no banco e a
senha em texto puro não é guardada em lugar nenhum — o que fica no Render
é o hash scrypt (N=2^17), envelopado em base64.

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

**Prazo decidido em 11/09/2026: 5 anos contados da transação.** Escolhido
por alinhar-se ao prazo de reclamação do CDC (art. 27) e à guarda fiscal
usual. Depois desse prazo o dado é expurgado.

Exclusão antes do prazo, a pedido do titular (LGPD art. 18), é atendida
caso a caso — respeitada a guarda legal do que não pode ser apagado
enquanto o prazo fiscal correr.

> ⚠️ **DUAS PENDÊNCIAS ABERTAS, e elas são diferentes uma da outra:**
>
> 1. **A rotina de expurgo não existe.** O prazo está decidido, mas
>    nada apaga nada hoje. Enquanto não houver a rotina, o prazo é
>    intenção, não prática.
> 2. **Validação jurídica pendente.** Os 5 anos são a escolha mais
>    defensável sem advogado, não um parecer. A skill `legal` fecha isso
>    na Estação 7, antes do lançamento — e é de lá que sai o texto da
>    Política de Privacidade.
>
> Vale também para a Asaas: o dado que foi enviado a ela segue a
> retenção **dela**, não a nossa.

## 6.1 Dado pessoal dentro do próprio repositório

> ⚠️ **PENDÊNCIA ABERTA — confirmada no histórico, não só suspeita.** A
> pasta `Claude outputs/` contém capturas de tela do painel
> administrativo com **dado pessoal legível**: nome, e-mail, telefone,
> endereço completo, data de nascimento e faturamento declarado, de
> pessoa física e de empresa.
>
> As credenciais nessas imagens estão mascaradas (conferido em
> 11/09/2026) — a máscara protege o segredo, não a pessoa.
>
> **RESOLVIDO EM 11/09/2026.** Durante a Estação 4 confirmou-se que a
> pasta havia sido commitada: três commits tocavam o caminho
> (`b24a47f`, `d4b31c4`, `cadc248` — identificadores de antes da
> reescrita, que já não existem). Sair do `HEAD` e entrar no
> `.gitignore` impedia daqui para frente, mas não alcançava o que já
> tinha subido — e nenhuma rotina de exclusão chega ao histórico do git.
>
> O dono reescreveu o histórico com `git filter-repo --path
> "Claude outputs" --invert-paths` e forçou o push. **Reverificado no
> GitHub:** o histórico do caminho `Claude outputs` responde *"No commits
> history"*, e todos os SHAs mudaram (o topo do `main` passou de
> `4c01cda` para `1fc7038`), o que confirma a reescrita.
>
> Ressalva registrada: o GitHub mantém objetos órfãos alcançáveis por SHA
> direto até a coleta de lixo dele; para garantia total seria preciso
> pedir o `gc` ao suporte. O repositório é privado, com um único
> contribuidor, e nunca houve exposição a terceiro.
>
> Os arquivos continuam no disco local, fora do versionamento — é onde
> devem ficar.

## 6.2 O caminho de exclusão existe na modelagem (verificado na Estação 4)

A skill `legal` trata isto como decisão de arquitetura, não de texto: se
o modelo não permitir apagar sem quebrar histórico ou guarda fiscal, o
problema é de modelagem. Conferido contra o `supabase/schema.sql`:

- Em `cobrancas`, o dado pessoal (`documento`, `email`, `telefone`, os
  oito campos de endereço, `itens`) está em colunas **separadas** do
  registro financeiro (`charge_id`, valores, taxas, `metodo_pagamento`,
  `status`, datas). Anonimizar é anular as primeiras e manter as
  segundas — a linha continua servindo de registro fiscal e de
  conciliação sem identificar ninguém.
- Em `assinaturas`, `documento` faz parte da chave de busca
  (`contratante_id` + `plano_id` + `documento`). Anonimizar quebra a
  busca, mas só faz sentido anonimizar assinatura **cancelada**, que já
  não é buscada.
- `subcontas` é dado do operador/parceiro, não do comprador, e tem
  guarda própria enquanto a subconta existir na Asaas.

Ou seja: o que falta é a **rotina**, não a possibilidade. A modelagem
não precisa mudar para atender a LGPD art. 18.

## 7. Log

O backend registra o payload cru dos webhooks da Asaas
(`console.log` em `webhookController.js`). Esse payload **contém dado
pessoal do comprador**. Não contém dado de cartão.

> ⚠️ **PENDÊNCIA ABERTA.** Log de produção com dado pessoal em texto
> puro, retido pelo Render. Avaliar reduzir para os campos necessários ao
> diagnóstico assim que o formato dos eventos estiver confirmado ao vivo
> — o log completo existe justamente porque o formato ainda não foi
> confirmado.
