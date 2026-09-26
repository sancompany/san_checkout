# Inventário de dados pessoais — San Checkout

Atualizado em 26/09/2026, conferido campo a campo contra o banco de
produção (`information_schema.columns`, lido nesse dia), as migrations
`0001` a `0020`, o código de `src/` e de `public/js/`, o `API.md` e os
cabeçalhos servidos pelas páginas em produção. A versão anterior era de
11/09/2026, com acréscimos pontuais até 24/09.

Regra de manutenção: **campo novo sem linha nova é tarefa incompleta.**
Este arquivo é o registro das operações de tratamento (LGPD art. 37) e a
fonte dos Termos de Uso e da Política de Privacidade (skill `legal`).

---

## 0. O que mudou nesta revisão, e o que estava errado

A conferência de 26/09/2026 achou seis afirmações falsas ou incompletas
neste arquivo e na Política v3:

1. **Dois terceiros recebiam dado do Pagador sem estar declarados.** O
   Google Fonts recebe o IP, o agente do navegador e a página de origem
   de todo visitante, porque todas as páginas carregam as fontes de
   `fonts.googleapis.com`. O ViaCEP recebe o CEP digitado no cartão e na
   assinatura por cartão (`public/js/utils/cep.js`). Os dois estão
   liberados na CSP de `public/_headers`, e nenhum documento os citava.
   Estão declarados na Política v4, §15.11 e §15.12.
2. **O hash do documento não é irreversível.** `clientes_asaas` guarda
   `sha256(documento)` sem sal (`asaasService.js`). O espaço de CPFs é
   pequeno: dá para enumerar todos e achar o original. É **dado pessoal
   pseudonimizado**, não anônimo.
3. **`clientes_asaas` não entra no expurgo.** Este arquivo dizia que a
   tabela "entra no expurgo por titular". Não entra: `expurgoService.js`
   só lê `cobrancas` e `assinaturas`. Ver §6.3.
4. **"Anonimizar" não é anonimização no sentido da LGPD.** A linha de
   `cobrancas` sem os dados pessoais continua com o `charge_id`, e esse
   id leva ao cliente dentro da Asaas, a que o controlador tem acesso.
   O certo é chamar de **remoção dos dados de identificação do nosso
   banco**, ou pseudonimização (LGPD art. 13, §4º). A Política v4 não
   usa mais "anonimizado" para isso.
5. **A seção do operador falava em variável de ambiente "do Render".** O
   backend está no Northflank desde 12/09/2026.
6. **A transição para pessoa jurídica foi descrita como se estivesse em
   curso.** Decisão do dono em 26/09/2026: ela não está em curso, e o
   CNPJ que aparecia na v1 pertence a outra atividade, que não
   representa o San Checkout, o SAN & CO. Pay nem o MostrAí. Ver §4.1.

---

## 1. Registro por dado

Base legal: artigo 7º da LGPD. **V** é execução de contrato ou de
procedimentos preliminares, **II** é obrigação legal, **VI** é exercício
regular de direitos e **IX** é legítimo interesse. Nenhum tratamento aqui
se apoia em consentimento.

### 1.1 Pagador (titular terceiro — não é o operador)

| Dado | Origem | Finalidade | Onde fica | Quem recebe | Base legal | Retenção | Como sai |
|---|---|---|---|---|---|---|---|
| Nome ou razão social | digitado pelo Pagador, ou pré-preenchido pelo Lojista no `pagador` do `GET /pedido` | identificar o pagador na Asaas | **não é gravado** no nosso banco; só trafega | Asaas | V | — | — |
| CPF/CNPJ (`cobrancas.documento`) | idem | exigência da Asaas para criar a cobrança; conciliação; chave de busca da assinatura | Supabase `sa-east-1` | Asaas; o Lojista (só em assinatura, no webhook e na conciliação) | V; II e VI na guarda | 5 anos de `confirmado_em` (ou de `criado_em`, se não confirmou) | `expurgarDadoPessoal()` anula a coluna; a pedido, `expurgarDadoPessoalDoTitular()` |
| E-mail (`cobrancas.email`) | idem | identificar o cliente na Asaas | Supabase | Asaas | V | idem | idem |
| Telefone (`cobrancas.telefone`) | idem | exigência da Asaas em cartão e assinatura por cartão; opcional em Pix e boleto | Supabase | Asaas | V | idem | idem |
| Endereço: `endereco`, `endereco_numero`, `endereco_complemento`, `bairro`, `cep`, `cidade`, `uf`, `cidade_ibge` | digitado pelo Pagador; rua, bairro, cidade e UF completados pelo ViaCEP | antifraude da Asaas, **só em cartão e assinatura por cartão** | Supabase | Asaas; o **CEP** também vai ao ViaCEP, direto do navegador | V | idem | idem |
| Itens do pedido (`cobrancas.itens`) | Lojista, pelo `GET /pedido` | resumo na tela e conciliação | Supabase | — | V | idem | idem |
| Valores, taxas, cupom, método, parcelas, status e datas | calculado aqui e informado pela Asaas | registro financeiro e conciliação | Supabase | Lojista, no webhook e na conciliação | V, II | **permanece** depois da remoção dos dados pessoais, sem identificar o Pagador | não sai: é o registro financeiro (§6.2) |
| Associação `sha256(documento)` → `asaas_customer_id` (`clientes_asaas`) | derivado do CPF/CNPJ | não criar dois clientes na Asaas para o mesmo titular (migration 0015) | Supabase | — | V | **sem prazo automático hoje** | manualmente, a pedido do titular; a rotina automática é mudança técnica pendente (§6.3) |
| IP, agente do navegador, página de origem | a conexão | entregar as páginas | não gravados por nós | Cloudflare (Pages, Web Analytics); **Google Fonts**; ViaCEP (na consulta de CEP) | IX | definida por cada fornecedor | — |
| IP de origem na API | a conexão | limitar a frequência de requisições | **só em memória**, no limitador do Express | — | IX | enquanto dura a janela do limitador | expira sozinho |

**Não coletado, nunca:** número de cartão, CVV, validade e nome do
titular do cartão. Esses dados são digitados numa pop-up hospedada pela
Asaas e não passam por este servidor nem pelo do contratante
(`API.md` §6.2). Na assinatura por cartão, a Asaas guarda o cartão
vinculado à assinatura e faz as cobranças recorrentes.

**Token do cartão:** a Asaas devolve `creditCardToken` no `GET` de uma
assinatura por cartão. O código só o lê em memória, em
`dadosDeCobrancaDaAssinatura()`, e **nunca o grava**. Esse caminho só
seria usado para cobrar o acerto da troca de plano, e desde 26/09/2026
ele não é alcançado: a troca de plano em assinatura de cartão responde
`409` antes de qualquer efeito (RN-35.4, ADR-011). Por isso a Política
v4, §5.4, pode dizer que nesta versão não há cobrança avulsa em cartão
já cadastrado.

### 1.2 Assinante

| Dado | Origem | Finalidade | Onde fica | Quem recebe | Base legal | Retenção | Como sai |
|---|---|---|---|---|---|---|---|
| CPF/CNPJ (`assinaturas.documento`) | o mesmo da cobrança | com `contratante_id` + `plano_id`, é a chave para cancelar, pausar, retomar, trocar e conciliar (`API.md` §5.5) | Supabase | Asaas; Lojista, no webhook e na conciliação | V | enquanto ativa ou pausada; depois de cancelada, até 5 anos de `criado_em` | `expurgarDadoPessoal()` troca por `'expurgado'` (a coluna é `not null`) |
| Plano, valor, ciclo, status, próxima cobrança, plano anterior, data da troca | Lojista (`GET /plano`) e Asaas (conciliação) | executar e conciliar a assinatura | Supabase | Lojista | V | permanece com a linha | não sai |
| Outbox (`outbox_notificacoes.payload`) | montado aqui | avisar o Lojista, com entrega garantida | Supabase | Lojista | V | 90 dias após `enviada` ou `abandonada` | `expurgarOutbox()` apaga a linha |

### 1.3 Troca de plano (`intencoes_troca_plano`, migration 0011)

A linha registra uma troca de plano com acerto a pagar: o retrato do
acerto (planos, valores, ciclo, crédito e débito) e o estado da aprovação
do assinante em `/troca`.

- **Natureza do dado.** Não tem coluna de dado pessoal direto: não tem
  documento, IP nem agente do navegador. Mas é **dado pessoal por
  vínculo**, porque `assinatura_id` leva à assinatura, que tem o
  documento. Enquanto esse vínculo existir, a linha fala de uma pessoa
  identificável.
- **Finalidade.** Executar a troca aprovada pelo assinante e guardar a
  prova de que ele aprovou o valor antes da cobrança (RN-35.2). Se a
  cobrança do acerto for contestada, essa é a evidência.
- **Base legal.** V para executar a troca; VI para guardar a prova.

**Retenção, decidida nesta revisão:**

| Situação da intenção | Prazo | Por quê |
|---|---|---|
| Houve cobrança de acerto (`charge_id` preenchido) | **5 anos** de `concluida_em` (ou de `criada_em`, se não concluiu) — o mesmo prazo da cobrança do acerto | é a prova da aprovação daquela cobrança, e precisa durar tanto quanto ela |
| Não houve cobrança (expirada, cancelada, obsoleta ou recusada sem cobrança) | **90 dias** depois de `expira_em` | não há cobrança a defender; os 90 dias cobrem a investigação de um relato do Lojista |

**LEGAL_REQUIRES_TECH_CHANGE = TRUE.** Hoje nenhuma rotina aplica esse
prazo, e as linhas nunca são apagadas. A mudança necessária é uma
função `expurgarIntencoesDeTroca()` ligada ao ciclo de 24 h de
`rodarExpurgoDasFilas` em `server.js`, que:

1. apague as linhas **sem** `charge_id` em estado terminal com
   `expira_em` de mais de 90 dias;
2. apague as linhas **com** `charge_id` e `coalesce(concluida_em,
   criada_em)` de mais de 5 anos, usando `dataDeCorte()` do
   `expurgoService.js` para não duplicar a regra de 29 de fevereiro;
3. **nunca** toque em linha em estado não terminal (`PENDING_APPROVAL`,
   `PROCESSING_PAYMENT`, `PAYMENT_UNKNOWN`, `PAYMENT_CONFIRMED`,
   `APPLYING_PLAN`, `RECONCILIATION_REQUIRED`), porque o sweeper de 60 s
   ainda trabalha nelas.

A tabela tem **0 linhas** em produção em 26/09/2026. A troca de plano em
assinatura de cartão está recusada (RN-35.4), e Pix Automático está
desligado nesta conta. Por isso nada precisa ser feito às pressas, mas a
mudança deve estar pronta antes de a troca voltar a estar disponível
para algum meio. Não foi feita nesta tarefa, que proibia mudar o
comportamento do Checkout.

### 1.4 Titular de subconta Asaas

Tabela `subcontas`, preenchida pelo operador no painel ao abrir uma
subconta: `nome`, `email`, `documento`, `telefone`, `celular`,
`endereco`, `endereco_numero`, `complemento`, `bairro`, `cep`,
`faturamento`, `tipo_empresa`, `data_nascimento`. Enviados à Asaas em
`POST /v3/accounts`. Guarda também `wallet_id`, `api_key` e
`link_ativacao` da subconta — credenciais, não dado pessoal, mas com o
mesmo cuidado de exposição (mascaradas na tela, reveladas só sob clique).

- **Finalidade e base legal:** abrir e manter a subconta do Lojista (V).
- **ViaCEP:** quando o operador informa o CEP no formulário de subconta,
  o painel consulta o ViaCEP pelo navegador, para completar logradouro
  e bairro (`public/js/admin.js`, o mesmo `buscarEnderecoPorCep` do
  checkout). O ViaCEP recebe o CEP do titular da subconta.
- **Retenção:** enquanto a subconta existir na Asaas; depois de
  arquivada, 5 anos, pelo mesmo raciocínio da cobrança.
- **Estado real:** **0 linhas** em produção. A conta-mãe é pessoa física
  e não cria subconta (`CONSTRAINTS.md` §2.5.3), então o recurso não é
  usado. Não há rotina de expurgo para esta tabela. Quando ela entrar em
  uso, a rotina entra junto (**LEGAL_REQUIRES_TECH_CHANGE**, sem
  urgência).

### 1.5 Operador

- **Login do painel.** `CHECKOUT_ADMIN_USER` e
  `CHECKOUT_ADMIN_PASS_HASH` ficam em variável de ambiente do
  **Northflank**. Esta linha dizia "Render" até 26/09/2026. Não há
  tabela de usuários nem senha no banco, e a senha em texto puro não é
  guardada em lugar nenhum: o que fica é o hash scrypt (N=2^17),
  envelopado em base64.
- **Sessão do painel.** O token assinado fica no `sessionStorage` da aba
  (`public/js/admin.js`). Não é cookie e não é gravado no servidor.
- **Cloudflare Access.** Trata o e-mail do operador para autorizar a
  entrada em `/admin`. É o único lugar do sistema que grava cookies
  (`CF_AppSession`, `CF_Authorization`), e eles são estritamente
  necessários à autenticação.

### 4.1 O CPF do operador é PUBLICADO, e é obrigação legal

*(O número da seção foi mantido porque `CONSTRAINTS.md` §3 aponta para
ele.)*

Os Termos e a Política identificam o operador como **pessoa física**:
nome civil, **CPF** e endereço, em página pública.

| dado | onde | por quê |
|---|---|---|
| nome civil | `public/termos.html` §1.1, `public/privacidade.html` (contatos e rodapé) | Decreto 7.962/2013, art. 2º, I: o fornecedor identifica-se com nome e inscrição **no CPF ou no CNPJ** (conferido no Planalto em 26/09/2026) |
| CPF | idem | operando como pessoa física, o CPF **é** a inscrição exigida |
| endereço físico | idem | mesmo artigo, inciso II: endereço físico e eletrônico |

**A exposição é consciente, não descuido.** CPF em página pública é
identificador de alto valor no Brasil e fica sujeito a coleta
automatizada. Não há alternativa legal enquanto a operação for de pessoa
física: omitir a inscrição descumpre o Decreto, e publicar parcialmente
não identifica.

**Não há transição para pessoa jurídica em curso**, por decisão do dono
em 26/09/2026. O CNPJ que aparecia na v1 dos documentos
(`docs/legal-arquivado/`) pertence a **outra atividade**, e não representa o San
Checkout, o SAN & CO. Pay nem o MostrAí. Os documentos vigentes dizem
apenas que, se a operação for um dia transferida para pessoa jurídica,
eles serão atualizados antes ou no momento da alteração.

Este é o único dado pessoal **do operador** que o projeto publica. Nada
de titular de terceiro é publicado em lugar nenhum.

---

## 5. Onde os dados ficam, e quem mais recebe

| Onde | O quê | Região, e como foi conferida | Observação |
|---|---|---|---|
| Supabase (Postgres) | tudo das seções 1.1 a 1.4 | `sa-east-1` — **Brasil**, conferido em 26/09/2026 pela API do Supabase | RLS habilitado em **todas as 13 tabelas** (conferido no mesmo dia, em `pg_class`). Desde a migration 0020, `anon` e `authenticated` não têm privilégio em tabela, sequência ou função, e a chave pública recebe `42501`. Só o backend acessa, com `service_role` |
| Asaas | cliente, cobrança, assinatura, cartão da assinatura, subconta | provedor brasileiro | é controladora dos tratamentos próprios dela (obrigação regulatória, antifraude) e segue a própria retenção. Notificação ao comprador desligada em todo cliente criado (`notificationDisabled: true`) |
| Northflank | execução do backend; logs da aplicação | `nf-southamerica-east` — **Brasil**, conferido em 26/09/2026 pela CLI do provedor | empresa estrangeira: a administração e o suporte do provedor podem envolver metadado fora do Brasil. A retenção dos logs é definida pela Northflank. Ver §7 |
| Cloudflare Pages | as páginas estáticas | rede global | não recebe dado pessoal em repouso, mas trata **dado técnico de conexão em trânsito** (IP, agente do navegador, metadados), porque é ela que entrega a página |
| Cloudflare Web Analytics | métrica de desempenho da página | rede global | ativo desde 01/09/2026, injetado pela própria Cloudflare (`auto_install`), por isso ausente do HTML do repositório (`script-src` da CSP libera `static.cloudflareinsights.com`). Conferido na documentação oficial em 26/09/2026: sem cookie e sem `localStorage`, sem *fingerprinting*, sem rastreamento entre sites de clientes, e não registra *query string*. A Cloudflare mantém os *beacons* integrais por **7 dias** e depois só agregados, em amostra de cerca de 10%. Base legal IX |
| Cloudflare Access | e-mail do operador, cookie de sessão do `/admin` | rede global | só o operador |
| **Google Fonts** | IP, agente do navegador e página de origem de **todo visitante** | infraestrutura global do Google | declarado pela primeira vez em 26/09/2026 (Política v4, §15.11). Conferido no FAQ oficial do Google Fonts: a API não grava cookie, e o dado não é usado para perfil de usuário final nem para publicidade direcionada. Base legal IX. **Alternativa técnica, não obrigatória:** servir as fontes do próprio domínio, o que tira o Google do caminho |
| **ViaCEP** | o CEP digitado e o dado técnico da conexão | não verificada | declarado pela primeira vez em 26/09/2026 (Política v4, §15.12). É chamado **pelo navegador** em dois lugares: no checkout, só no cartão e na assinatura por cartão, com o CEP do Pagador; e no painel, com o CEP do titular de uma subconta (§1.4). Base legal V (procedimento preliminar do pagamento ou da abertura da subconta) |
| Google Workspace | as mensagens recebidas em `juridico@`, `suporte@`, `contato@` e `financeiro@` | infraestrutura global | MX `smtp.google.com`, conferido em 26/09/2026. A aplicação **não envia e-mail**: não há biblioteca de envio em `src/` nem em `package.json`, conferido em 26/09/2026 |
| Contratante (Lojista) | payload do webhook e resposta da conciliação | o ambiente dele | pedido avulso: `pedidoId`, valores, cupom e taxas, **sem documento**. Assinatura: `documento`, `planoId`, `assinaturaId` e valores. Nunca endereço nem cartão (`API.md` §4.3.3 e §4.3.4) |
| Contratante (navegação de volta) | só o `pedidoId`, na URL de retorno | — | desde 15/09/2026. O `returnUrl` leva **um** parâmetro, `pedido`, que o próprio contratante gerou. Nenhum dado pessoal e nenhum status de pagamento viajam por aí (`API.md` §3.1) |

### 5.2 As quatro tabelas da consolidação financeira (migration 0015, 24/09/2026)

| Tabela | Guarda | Dado pessoal? | Retenção |
|---|---|---|---|
| `webhook_inbox` | o evento da Asaas, gravado ANTES do `200`, por **lista branca** de campos (ids, status, valores, datas, `refunds`). O `externalReference` só entra quando é a nossa referência (`reserva-<uuid>`, `troca:<id>`); cobranças anteriores a 22/09 levavam o CPF nesse campo, e ele fica de fora | **não** — nome, e-mail, documento, telefone, endereço e cartão nunca entram | 90 dias para `processado`/`ignorado` (`expurgarInbox`, diário); `falhou` esgotado fica até alguém olhar, sem dado pessoal |
| `outbox_notificacoes` | o aviso ao contratante, com o payload que ele recebe; em assinatura, leva `documento` | **sim, `documento`**, no payload de assinatura | 90 dias para `enviada` e `abandonada` (`expurgarOutbox`, diário) |
| `cotacoes` | o retrato do preço mostrado ao pagador (campos financeiros do pedido ou plano, descrição, itens) | **não** — o `pagador` pré-preenchido pelo contratante NÃO entra no retrato | 24 h depois de vencida (`expurgarCotacoes`, diário) |
| `clientes_asaas` | `sha256(documento)` → id do cliente na Asaas | **sim, pseudonimizado.** Esta linha dizia "hash SHA-256, irreversível", e é falso: é SHA-256 **sem sal** de um CPF, e o espaço de CPFs se enumera. O id da Asaas também é pseudônimo | **sem prazo automático** — ver §6.3 |

### 5.3 `estornos` (migration 0018)

Uma linha por pedido de estorno: ids da cobrança e do contratante,
`charge_id`, chave de idempotência, valor, estado, contadores e última
mensagem de erro.

- **Natureza do dado.** Nenhuma coluna identifica a pessoa diretamente,
  mas a linha é **dado pessoal por vínculo**, a mesma classificação de
  `intencoes_troca_plano` (§1.3). `cobranca_id` aponta para a linha de
  `cobrancas`, que guarda documento, e-mail, telefone e endereço
  enquanto não passa do prazo. `charge_id` leva ao cliente dentro da
  Asaas. Até 26/09/2026 esta seção dizia "sem dado pessoal", e a
  revisão automática da PR #64 apontou a contradição com o §1.3.
- **Finalidade e base legal.** Executar o estorno autorizado pelo
  Lojista sem devolver duas vezes (V), e guardar o registro financeiro
  da devolução (II e VI).
- **Retenção.** A linha fica pelo mesmo tempo que o registro financeiro
  da cobrança (§6.0, linha 2). O vínculo com a pessoa acaba no nosso
  banco quando a cobrança referenciada perde os dados de identificação,
  ao fim dos 5 anos ou a pedido do titular. Depois disso, `estornos`
  fica na mesma situação do registro financeiro que sobra em
  `cobrancas`: pseudonimizado pelo `charge_id` da Asaas, sem dado de
  identificação no nosso banco.
- **Eliminação.** Não precisa de rotina própria, porque não tem coluna
  pessoal a anular. O que remove o vínculo é o expurgo de `cobrancas`.
  Se um dia `estornos` ganhar coluna com dado de pessoa, ela precisa
  entrar numa lista branca, como em `cobrancas`.

### 5.4 Colunas que existem e não guardam nada

- `cobrancas.nota_fiscal_id`, `nota_fiscal_drive_file_id` e
  `nota_fiscal_status` vêm da baseline (0001), de quando havia emissão
  de nota. Esse recurso foi **removido do escopo em 08/09/2026**
  (`CONSTRAINTS.md` §1.9). `nota_fiscal_status` nasce `'pendente'` por
  *default*, e nenhum código lê ou escreve as três: elas só aparecem na
  lista branca do `expurgoService.js`, como colunas que ficam.
- `contratantes.drive_folder_id` tem a mesma origem e está vazia em
  todas as linhas.

Nenhuma delas guarda dado pessoal. Estão registradas aqui para que
ninguém as leia como prova de que existe emissão fiscal.

---

## 6. Retenção e eliminação

### 6.0 Os prazos por categoria, e de onde vem cada um

A pergunta de 26/09/2026 foi se "5 anos para tudo" se sustenta. Não
para tudo. A tabela abaixo é o que vale hoje, com o fundamento de cada
linha:

| Categoria | Prazo implementado | Fundamento | Estado |
|---|---|---|---|
| Dado de identificação e contato da cobrança (documento, e-mail, telefone, endereço, itens) | 5 anos de `confirmado_em`/`criado_em` (`ANOS_DE_RETENCAO`) | CDC art. 27 (5 anos para reparação de dano); Código Civil art. 206, §5º, I (5 anos para cobrar dívida líquida de instrumento); defesa em contestação de pagamento | **mantido** |
| Registro financeiro da cobrança, sem identificação, e as linhas de `estornos` que apontam para ela (§5.3) | permanece | guarda contábil e fiscal; não identifica pessoa no nosso banco | **mantido**, ver ressalva de contagem abaixo |
| Documento da assinatura | enquanto ativa ou pausada; cancelada, até 5 anos de `criado_em` | é a chave com que o assinante cancela (§6.2); as cobranças da assinatura guardam o próprio documento pelos 5 anos delas | **mantido** |
| Outbox | 90 dias | reenvio e diagnóstico de entrega | **mantido** |
| Inbox | 90 dias (sem dado pessoal) | diagnóstico e idempotência | **mantido** |
| Auditoria do webhook | eventos 90 dias; IP das rejeições 30 dias; contagem por hora sem prazo (sem dado pessoal) | registro de segurança | **mantido** |
| Erros | 30 dias (sem dado pessoal) | diagnóstico | **mantido** |
| Cotações | 24 h após vencer (sem dado pessoal) | prova do preço mostrado até o pagamento | **mantido** |
| `clientes_asaas` | sem prazo automático | evitar cliente duplicado na Asaas | **a corrigir**, ver §6.3 |
| `intencoes_troca_plano` | nenhum hoje | ver §1.3 | **decidido nesta revisão, código pendente** |
| `subcontas` | nenhum hoje (0 linhas) | ver §1.4 | pendente, sem urgência |
| E-mails nos canais (Google Workspace) | sem rotina | atendimento; prova de atendimento ao titular | operação manual: guardar enquanto o atendimento durar e, se for pedido de titular ou reclamação, pelos mesmos 5 anos |
| Registro de incidentes de segurança | mínimo de 5 anos | Resolução CD/ANPD nº 15/2024, art. 10 | é registro do operador, fora do banco (`RUNBOOK` §8.1) |
| Registro de acesso (Marco Civil, art. 15) | não mantido | o dever do art. 15 é de provedor **pessoa jurídica**. O operador é pessoa física e o sistema não grava IP de Pagador | **não se aplica hoje**, e passa a se aplicar se a operação virar pessoa jurídica |

**ACCOUNTING_VALIDATION_REQUIRED — como contar os 5 anos.** O prazo de
decadência tributária do CTN (art. 173, I) conta do **primeiro dia do
exercício seguinte** ao fato, e não da data da transação. Uma cobrança
de janeiro de 2026 teria a guarda fiscal até 31/12/2031, quase seis
anos. Isso não afeta o registro financeiro, que fica de qualquer jeito
(linha 2 da tabela). Afeta só a remoção do documento: se o contador
disser que a guarda fiscal exige o documento do Pagador, a mudança é em
`dataDeCorte()` do `expurgoService.js`, para contar do fim do ano-calendário
da transação em vez da data dela. Não alterado sem essa resposta.

**PENDING_EXTERNAL_VALIDATION — minimização do contato.** E-mail,
telefone e endereço servem para criar a cobrança e para a defesa numa
contestação de cartão. Talvez não precisem dos mesmos 5 anos do
documento, e um advogado pode recomendar prazo menor para eles. Se
recomendar, a mudança é uma segunda faixa na lista branca do
`expurgoService.js`, com prazo próprio para essas colunas. Até lá, fica
o prazo único que existe e está implementado.

### 6.1 A rotina existe desde 17/09/2026

`src/services/expurgoService.js`, ligada ao ciclo de 24 h do
`server.js`, com porta de mão para o operador em `npm run expurgo`
(simula por padrão). Duas funções, porque são duas coisas diferentes:
o **prazo** (`expurgarDadoPessoal`, cinco anos) e o **pedido do
titular** (`expurgarDadoPessoalDoTitular`, LGPD art. 18, antes do
prazo, que relata o que ficou retido em vez de fingir que apagou).

Decide por **lista branca do que FICA**, não por lista do que sai:
lista negra falha aberta, e falhar aberta aqui é uma coluna pessoal
criada em 2027 sobrevivendo para sempre porque alguém esqueceu de
atualizar um arquivo. O autoteste confere a lista contra as colunas
reais do banco, então coluna nova deixa a suíte vermelha até alguém
decidir de que lado ela fica.

Conferida contra o banco de produção em 17/09/2026, em simulação: com o
corte real, não alcança nenhuma linha, porque não existe transação de
cinco anos atrás. Ela não faz nada até 2031; o valor de estar ligada
agora é não depender de alguém lembrar em 2031.

O dado enviado à Asaas segue a retenção **dela**, não a nossa.

### 6.2 O caminho de exclusão existe na modelagem (verificado na Estação 4)

Conferido contra as migrations numeradas em `supabase/migrations/` (a
`0001_baseline.sql` tem os `create table`):

- Em `cobrancas`, o dado pessoal (`documento`, `email`, `telefone`, os
  oito campos de endereço, `itens`) está em colunas **separadas** do
  registro financeiro. Remover as primeiras e manter as segundas deixa
  a linha servindo de registro fiscal e de conciliação sem identificar
  ninguém **no nosso banco**. O `charge_id` continua levando ao cliente
  dentro da Asaas: por isso isto é remoção de identificação, e não
  anonimização no sentido da LGPD (§0, item 4).
- Em `assinaturas`, `documento` faz parte da chave de busca
  (`contratante_id` + `plano_id` + `documento`). Remover quebra a busca,
  mas só se remove de assinatura **cancelada**, que já não é buscada.
- `subcontas` é dado do operador ou do parceiro, não do comprador (§1.4).

**Assinatura viva (ativa ou pausada) não é tocada nem a pedido do
titular**, porque o `documento` é a chave com que ele cancela a própria
assinatura (`API.md` §5.5). Apagar o documento tiraria dele a capacidade
de cancelar, que é o oposto do que o pedido quer; cancelar por conta
própria seria decidir por outra pessoa algo com consequência financeira.
A rotina **relata** as assinaturas vivas em vez de agir: o titular
cancela com o Lojista, e o expurgo alcança na rodada seguinte.

### 6.3 `clientes_asaas` fica de fora do expurgo — LEGAL_REQUIRES_TECH_CHANGE

A tabela guarda `sha256(documento)` sem sal, que é dado pessoal
pseudonimizado (§5.2), e **nenhuma rotina a apaga**: nem o prazo, nem o
pedido do titular. Até 26/09/2026 este arquivo afirmava o contrário.

**Prazo decidido:** a associação serve enquanto houver cobrança do
titular que ainda guarda o documento. Quando a última cobrança dele
perder o documento pelo prazo, ou quando ele pedir exclusão e não houver
mais cobrança dele dentro dos 5 anos, a linha sai.

**Mudança técnica necessária**, não feita nesta tarefa:

1. em `expurgarDadoPessoalDoTitular()`, apagar a linha de
   `clientes_asaas` com o hash daquele documento quando nenhuma cobrança
   dele ficar retida;
2. em `expurgarDadoPessoal()`, apagar as linhas de `clientes_asaas` cujo
   hash não corresponda a nenhum documento ainda presente em
   `cobrancas`, lendo em lotes como o resto da rotina já faz;
3. *(recomendação, não obrigação)* trocar o SHA-256 puro por um HMAC com
   segredo do servidor, para que um vazamento da tabela sozinha não
   revele os CPFs. Isso exige migrar as linhas existentes.

Até o código existir, o pedido do titular inclui apagar a linha à mão,
pelo SQL do Supabase. É o que a Política v4, §20.4, alínea f, promete.

### 6.4 Dado pessoal dentro do próprio repositório — resolvido em 11/09/2026

A pasta `Claude outputs/` continha capturas de tela do painel com dado
pessoal legível, e tinha sido commitada. O dono reescreveu o histórico
com `git filter-repo --path "Claude outputs" --invert-paths` e forçou o
push; reverificado no GitHub, o caminho responde *"No commits history"*.
Ressalva: o GitHub mantém objetos órfãos alcançáveis por SHA direto até
a coleta de lixo dele. O repositório é privado, com um único
contribuidor, e nunca houve exposição a terceiro. Os arquivos continuam
no disco local, fora do versionamento.

---

## 7. Log

Desde 11/09/2026 o `webhookController.js` imprime e grava a versão
**redigida** dos webhooks (`redigirPayload`, em
`src/services/auditoriaWebhookService.js`): passa por lista branca de
nome de campo, e o que não está nela vira só o **caminho da chave**, sem
valor. O autoteste do serviço prova isso com um payload realista. Antes
dessa data, o payload cru, com dado do comprador, ia para o log da
hospedagem de então.

O log da aplicação no Northflank registra, por evento de webhook, o
nome do evento, a rota, a referência, o id e o IP de **origem da
chamada**, que é o servidor da Asaas e não o Pagador. A retenção desse
log é definida pela Northflank.

### 7.1 Tabelas do log de auditoria do webhook (migration 0002)

| Tabela | Dado pessoal | Retenção |
|---|---|---|
| `webhook_eventos` | **nenhum** — nome de evento, id da cobrança na Asaas, resultado e os campos redigidos | 90 dias (`expurgarAuditoria`, no boot e a cada 24 h) |
| `webhook_rejeicoes` | **endereço IP** de quem tentou usar o endereço do webhook sem o token, dentro de `amostras` | as amostras são esvaziadas depois de **30 dias**; a linha de contagem por hora fica, sem dado de pessoa |

O **token recusado nunca é gravado**: além de ser credencial em texto
puro, quem errasse uma letra do token certo gravaria o token certo no
banco.

### 7.2 Tabela da captura de exceção (migration 0007)

| Tabela | Dado pessoal | Retenção |
|---|---|---|
| `erros` | **nenhum, por construção** — contexto, padrão da rota, método, status, tipo e código do erro, quadros de pilha do nosso `src/`, e a mensagem **raspada** | 30 dias (`expurgarErros`, no boot e a cada 24 h) |

**O que nunca entra:** corpo da requisição, query string, cabeçalho, IP
e a URL real (`rota` guarda o **padrão** do Express). A mensagem é o
único texto livre, e é raspada antes de gravar: toda corrida de 4+
dígitos sai, e e-mail, token longo e query string também. O autoteste
de `erroService.js` prova isso.

---

## 8. Aceite dos documentos — o que o sistema consegue provar

Conferido no código em 26/09/2026:

- **Existe caixa de aceite** na tela de pagamento
  (`#accept-terms-checkbox` em `public/index.html`), com os links para
  os Termos e a Política. Sem ela marcada, `public/js/app.js` não deixa
  prosseguir.
- **O aceite não é gravado.** O servidor não recebe nem guarda que a
  caixa foi marcada, qual versão estava no ar ou um hash do texto. As
  telas `/status` e `/troca` não têm caixa de aceite.
- **O que dá para reconstruir:** a data da transação
  (`cobrancas.criado_em` e `confirmado_em`), a versão vigente naquela
  data (o histórico do git de `public/termos.html` e
  `public/privacidade.html`, mais as cópias em `docs/legal-arquivado/`)
  e o texto exato de cada versão (as cópias arquivadas, que são byte a
  byte o que foi publicado).

Então o sistema responde **qual versão estava vigente quando a
transação ocorreu, e qual texto estava disponível**. Ele **não** prova
que aquele Pagador marcou a caixa. Nenhum documento deste repositório
deve afirmar aceite registrado. Gravar o aceite, com a versão e um hash
do texto, seria mudança técnica e fica como decisão do dono
(`docs/pendencias.md`).

---

## 9. Crianças e adolescentes

O San Checkout é uma ferramenta de pagamento de produtos de Lojistas,
sem conteúdo próprio e sem apelo a criança. Na leitura razoável, não é
serviço direcionado a menores, e o Estatuto Digital da Criança (Lei
15.211/2025) não alcança o checkout em si. A avaliação é de cada Lojista
sobre o próprio produto. O checkout não pede idade, e a Política não
cria requisito de idade que ele não aplica.
