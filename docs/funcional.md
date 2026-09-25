# Definição funcional — San Checkout (SAN & CO. Pay Engine)

O que o sistema faz, tela por tela, em detalhe suficiente para construir
sem inventar comportamento.

**Registro retroativo**, escrito em 12/09/2026 a partir do que existe em
produção — não é desejo, é descrição. Reescrito em 13/09/2026 contra o
modelo da skill `leis` (`references/definicao-funcional.md`), lido na
fonte pela primeira vez: até então este arquivo seguia a paráfrase que
estava nos documentos do projeto, e divergia em seis das dez seções.
Onde o documento e o código divergirem, o código é a verdade e este
arquivo se ajusta.

**Este é o único documento de definição que muda durante o projeto.**
Comportamento ajustado é comportamento reescrito aqui, na mesma tarefa
que o ajustou. O `docs/specs/` registra por que o projeto existe e não se
atualiza; o `CONSTRAINTS.md` registra o que ele não faz; este diz o que
ele faz.

---

## 1. Público-alvo

Três papéis, e só o primeiro vê o produto.

**O comprador** — pessoa física ou jurídica pagando algo de um projeto do
ecossistema.
*Quer resolver:* pagar rápido, no celular, no meio de outra coisa.
*Sabe fazer sozinho:* copiar um código Pix e pagar no app do banco; ler
uma linha digitável. **Não** vai criar conta, não vai ler instrução, e
muitas vezes **não tem cartão de crédito** — é o motivo de Pix e boleto
serem cidadãos de primeira classe, não alternativas.

**O contratante** — o projeto que vende (Trimundi9, Vitrina ADS, os que
vierem).
*Quer resolver:* receber o dinheiro na conta e ser avisado, sem virar
especialista em meio de pagamento.
*Sabe fazer sozinho:* escrever código. É premissa do modelo pull — ele
expõe `GET /pedido/{id}` e recebe webhook. **Não usa tela nenhuma**, por
desenho.

**O operador** — uma pessoa, o dono.
*Quer resolver:* cadastrar contratante, criar subconta na Asaas, olhar
número e log de webhook.
*Sabe fazer sozinho:* tudo no painel; conhece o sistema; usa no
computador. É o **único** usuário do painel, e isso é premissa de
desenho: não há papéis, não há permissões, não há multiusuário.

---

## 2. Jornadas

### 2.1 Principal — o comprador paga uma compra avulsa por Pix

1. Recebe do contratante um link `checkout.sancocore.com.br/?c=<contratante>&pedido=<id>`.
2. A tela carrega e o checkout busca o pedido na API do contratante
   (modelo pull) — o valor vem de lá, nunca do navegador.
3. A tela mostra o resumo: item, subtotal, desconto, taxa e total.
4. Escolhe Pix e preenche nome, e-mail, CPF/CNPJ e telefone.
5. Marca o aceite dos Termos e da Política de Privacidade.
6. Clica em **Gerar QR Code Pix**; recebe QR, copia-e-cola e o **link
   permanente de status**.
7. Paga no app do banco. A página de status atualiza sozinha quando a
   Asaas confirma.
8. **Volta para a loja.** Se o contratante mandou `returnUrl` no link,
   a confirmação traz um botão "Voltar para {loja}" e uma contagem de
   10 s que leva sozinha. Sem `returnUrl`, a pessoa fica na tela de
   sucesso — que é onde ela ficava sempre, antes de 15/09/2026.

*Isso é tudo que essa pessoa precisa fazer?* Sim, para o caminho
principal. O resto são jornadas secundárias.

### 2.2 Comprador paga com boleto

Igual até o passo 5. Clica em **Gerar Boleto**, recebe linha digitável,
link do PDF e o link de status. Compensação leva de um a três dias
úteis — a página de status é o canal.

### 2.3 Comprador paga com cartão

Igual até o passo 5, mais o endereço completo (a Asaas exige para
cartão). Clica em **Continuar** e o pagamento acontece numa **pop-up
hospedada pela Asaas** — o cartão nunca passa por nós, que é o que
mantém o projeto fora do escopo PCI-DSS (`CONSTRAINTS.md` §1.1). Ao
final, a pop-up mostra "pode fechar" e a tela de trás atualiza.

### 2.4 Comprador assina uma recorrência

Link com `?assinatura=<planoId>` em vez de `?pedido=`. O resumo mostra o
valor do ciclo. Clica em **Assinar Agora** e vai pela pop-up da Asaas.
Assinatura por Pix Automático existe no código mas **está desligada**
(§2.4 do `CONSTRAINTS.md` — não liberada nesta conta).

### 2.5 Comprador acompanha o pagamento

`checkout.sancocore.com.br/status?c=<contratante>&pedido=<id>`. Página
pública, sem login, consulta periódica. É o link permanente entregue
junto do Pix e do boleto, e é a única página que o comprador guarda.

### 2.6 Comprador quer cancelar, desistir ou tratar dos seus dados

1. Abre o link de status que recebeu.
2. Lê no rodapé que cancelamento e arrependimento se resolvem **com a
   loja onde comprou** — é ela que autoriza o estorno, que volta pelo
   mesmo meio de pagamento.
3. Para dado pessoal (acesso, correção, exclusão, portabilidade), usa o
   canal do titular no mesmo rodapé: `juridico@sancocore.com.br`.
4. Para problema técnico na página, `suporte@sancocore.com.br`.

Nenhum dos três é botão, e o porquê de cada um está na seção 8.

### 2.7 Contratante integra e recebe (sem tela)

1. Cadastra-se com o operador e recebe id e `api_key`.
2. Expõe `GET /pedido/{id}`, autenticado por `X-Checkout-Key`.
3. Manda o comprador para o link do checkout.
4. Recebe o webhook de saída, assinado com a `api_key` dele.
5. Quando decide devolver, chama `POST /checkout/estornar` com a chave
   dele — a decisão de estornar é do lojista, a execução é nossa.
6. Quando o assinante muda de plano, chama `POST /checkout/trocar-plano`
   — se houver acerto a cobrar, o Checkout redireciona o assinante para
   aprovar o valor (RN-35.2); o contratante **também avisa por e-mail e
   no site dele** (RN-35), porque a tela do Checkout só pede aprovação
   do valor, não substitui o aviso do contratante sobre a troca em si.

### 2.8 Principal — o operador cadastra um contratante

1. Abre `/admin`, passa pelo Cloudflare Access.
2. Informa usuário e senha; recebe um token de sessão que vive só na aba.
3. **Contratantes → Novo contratante**: id (slug), nome, URL base da API,
   URL de webhook, wallet de split e métodos habilitados.
4. A `api_key` é gerada pelo backend e aparece mascarada na linha.
5. Revela com o olho, copia com o quadrado, entrega ao contratante.

### 2.9 Operador cria uma subconta na Asaas

Aba **Subcontas**: dados da empresa ou pessoa, endereço, documento. A
Asaas devolve `walletId`, que é o que faz o split pagar o contratante. O
`walletId` é colado à mão no contratante certo — as duas tabelas nunca
se ligam sozinhas.

### 2.10 Operador troca a chave de um contratante

Aba **Contratantes** → o **terceiro ícone ao lado da chave** (setas em
círculo), junto do olho e do copiar. A confirmação diz, com o nome do
contratante escrito, que a chave atual para de valer **na hora** e que a
integração dele fica parada até colar a nova. A chave nova aparece na
mesma célula.

O ícone fica junto da chave, e não na coluna de ações, porque é ali que
o operador está olhando quando decide trocá-la. E só aparece na chave de
contratante: a da subconta é emitida pela Asaas, e quem a troca é o
painel deles.

### 2.11 Operador arquiva um contratante

Aba **Contratantes → Arquivar**. Não existe excluir (`CONSTRAINTS.md`
§1.10). Arquivar tira da lista **e para de cobrar**: link antigo passa a
responder "contratante não encontrado" e a chave dele deixa de
autenticar estorno. Reversível em **Arquivados → Restaurar**.

### 2.12 Operador confere o que aconteceu

Aba **Métricas** (geradas, pagas, em aberto, perdidas, taxa de pagamento
e valor pago — total, por método e por contratante), aba **Webhook**
(todo evento recebido, com o payload redigido, e o contador de tentativas
recusadas) e aba **Erros** (toda exceção que virou 5xx, agrupada por
onde acontece, com quantas vezes aconteceu).

---

## 3. Telas

| tela | URL | quem acessa | o que mostra | o que dá para fazer | para onde leva |
|---|---|---|---|---|---|
| Checkout | `/` (`public/index.html`) | comprador | resumo do pedido ou do plano, e o formulário do pagador | escolher método, preencher dados, aceitar termos, gerar cobrança | página de status; ou pop-up da Asaas, no cartão |
| Status do pagamento | `/status` (`public/status.html`) | comprador | selo e texto do estado atual, dados do Pix ou boleto, rodapé com canais | copiar código, abrir boleto, achar o canal certo | Termos, Privacidade, e-mail dos canais |
| Aprovar troca de plano | `/troca#t=…` (`public/troca.html`) | assinante | resumo do acerto (crédito, débito, valor a pagar) — nunca escolha de plano | aprovar a cobrança exata | fecha na própria tela, com o resultado |
| Fechar pop-up | `/pagamento-popup-fechar.html` | comprador | "pode fechar esta janela" | fechar | volta ao checkout, que atualiza sozinho |
| Painel administrativo | `/admin` (`public/admin.html`) | operador | seis seções: Contratantes, Subcontas, Métricas, Arquivados, Webhook, Erros | cadastrar, editar, trocar chave, arquivar, criar subconta, ler métrica, log e exceções | permanece no painel |
| Termos de Uso | `/termos.html` | qualquer um | o contrato de uso da infraestrutura | ler | — |
| Política de Privacidade | `/privacidade.html` | qualquer um | tratamento de dados e direitos do titular | ler, achar o canal do Encarregado | e-mail do canal |
| Página não encontrada | `/404` (`public/404.html`) | quem digitou caminho inexistente | "esta página não existe" e o caminho de volta | escrever para o suporte | e-mail do suporte |

A lista fecha: toda tela citada em jornada existe aqui, e toda tela daqui
aparece em alguma jornada — a 404 na 2.1 pela negativa (link errado), as
duas legais na 2.1 (aceite) e na 2.6.

**A 404 não tem link para o checkout de propósito:** aberto sem `?c=` e
`?pedido=`, ele só mostraria "indisponível", que é pior que não oferecer
nada. O caminho de volta é o link da loja.

---

## 4. Estados de cada tela

Os seis estados do modelo, para cada tela. Estado que não se aplica está
escrito, nunca omitido.

### 4.1 Checkout (`/`)

| estado | o que aparece |
|---|---|
| Carregando | resumo em branco enquanto resolve o pedido |
| Sucesso (pronto) | resumo, total, métodos habilitados, formulário |
| Vazio | **não se aplica** — a tela é sempre de um pedido só; sem pedido ela é "indisponível", não vazia |
| **Erro / Indisponível** | contratante ou pedido não resolvido, **ou resposta sem valor cobrável** (ausente, zero, negativo ou acima do teto): total como **`R$ —`**, nunca `R$ 0,00`, e **nenhum botão de pagamento visível** |
| **Abaixo do valor mínimo** | total cobrável, mas **abaixo do piso de R$ 5,00 da Asaas**: a tela diz o mínimo e manda pedir um link novo ao vendedor, e o formulário não aparece (RN-28) |
| Pedido encerrado | pedido já pago ou cancelado na origem: mensagem de encerrado; não deixa cobrar de novo |
| Reserva expirada | `expiraEm` no passado: o cronômetro zera e a tela diz "Esta reserva expirou." |
| Resultado Pix | QR, copia-e-cola e link permanente de status |
| Resultado boleto | linha digitável, link do PDF e link permanente |
| **Pago, com volta** | só depois de CONFIRMADO, e só se o `returnUrl` do link tiver sido aprovado: botão "Voltar para {loja}" + contagem de 10 s, cancelável por qualquer clique, tecla ou rolagem |
| Pago, sem volta | `returnUrl` ausente ou de origem não autorizada: a tela fica na confirmação, sem botão — o `returnUrl` é ignorado em silêncio, e nada da cobrança muda |
| Sem permissão | **não se aplica** — a tela é pública por natureza; quem não deveria estar ali não tem o par contratante+pedido |
| Lista longa demais | **não se aplica** — o resumo mostra os itens do pedido, e pedido com muitos itens rola na própria lista, sem paginação |

O estado **Indisponível** é o mais importante e o que já passou
despercebido duas vezes
(`docs/erros/2026-09-11-total-ausente-virou-zero-na-tela.md` e
`docs/erros/2026-09-13-o-guarda-de-total-olhava-o-numero-errado.md`).

**A régua é uma só, e é a do caminho que cobra** (`valorValido`: maior
que zero e até R$ 100.000). Vale nos três lugares onde um número vira
preço:

- a rota que a tela consulta (`GET /pedido/…`) **não devolve taxa** —
  logo, não devolve total — para pedido cuja base não é cobrável. Sem
  isso ela anunciava R$ 1,49 de taxa sobre um pedido de R$ 0,00, e a tela
  ficava comprável;
- a tela do pedido recusa total não finito ou não positivo;
- a tela da assinatura recusa plano sem valor utilizável, em vez de
  deixar `R$ 0,00` aparecer com o botão de assinar ligado.

Protegido por `tests/total-nao-confiavel-nao-vira-tela-compravel.js`.

**Item sem preço mostra travessão, não `R$ 0,00`.** A linha de item do
resumo era o terceiro lugar da mesma família: `?? 0` transformava "não
sei o preço" em "o preço é zero", e zero numa linha de item lê como
brinde. O total continua sendo o do servidor — a linha é só o detalhe —,
então um item sem preço não derruba a tela; ele apenas para de afirmar
um valor que ninguém informou. O quarto lugar era a tela de status
(§4.2), corrigido junto.

### 4.2 Status (`/status`)

Seis estados de pagamento, com texto próprio cada um:

| status | selo | o que o comprador lê |
|---|---|---|
| `pendente` | Aguardando pagamento | "Assim que o pagamento for identificado, esta página atualiza sozinha." |
| `em_analise` | Em análise | "Recebemos seu pagamento e ele está passando por uma verificação de segurança." |
| `confirmado` | Pago | "Recebemos seu pagamento. A loja já foi avisada." |
| `recusado` | Recusado | "O pagamento não foi aprovado. Volte à loja para tentar novamente, se quiser." |
| `vencido` | Vencido | "O prazo de pagamento passou. Volte à loja para gerar uma nova cobrança." |
| `cancelado` | Cancelado | "Esta cobrança foi cancelada." |

E os do modelo: **carregando** mostra a estrutura sem selo; **erro** é
pedido sem cobrança, que devolve **404** e a tela mostra erro, não um
estado vazio; **vazio**, **sem permissão** e **lista longa** não se
aplicam — a página é de uma cobrança só, aberta por quem tem o par
contratante+pedido.

O rodapé aparece em todos os estados: canais e o aviso de que
cancelamento se resolve com a loja.

### 4.3 Painel administrativo (`/admin`)

Duas telas: **login** e **painel**.

| estado | o que aparece |
|---|---|
| Carregando | cada seção carrega sob demanda; a derivação da senha no login leva alguns segundos, por desenho (scrypt) |
| Sucesso | a seção pedida, com os dados |
| Vazio | texto próprio por seção: "Nenhum contratante cadastrado" (com "Cadastre o primeiro projeto que vai usar o checkout."), "Nenhuma subconta criada", "Nenhuma cobrança no período", "Nada arquivado", "Nenhum webhook recebido ainda", e na aba **Filas** (desde 24/09/2026) "Nenhum evento na inbox" / "Nenhuma notificação na outbox" |
| Erro | mensagem do backend em toast, sem detalhe interno |
| **Sem permissão** | Cloudflare Access barra antes da página **e antes da API** (desde 25/09/2026 o painel chama `/api/admin/*` pelo próprio domínio, atrás do Access — RN-61); chamada que chega à API sem o JWT do Access, `401` com "O painel administrativo só abre pelo endereço protegido", antes até do login; sem token válido, `401`; **backend sem as variáveis de admin devolve `503`, não `401`** — "admin desativado" é diferente de "senha errada"; chaves do Access ilegíveis, `503`; mais de 5 tentativas de login por minuto, `429` |
| Sessão do Access vencida no meio do uso | a chamada seguinte é redirecionada para o login da Cloudflare, e o navegador a recusa: o toast mostra um erro de rede. Recarregar `/admin` pede o login do Access de novo (`RUNBOOK.md`, "Perdi o acesso ao `/admin`") |
| Lista longa demais | a aba Webhook pede os **100** eventos mais recentes e o backend limita a **200** (padrão 50); as demais listas são pequenas por natureza — um operador, poucos contratantes |

Sem sessão guardada em cookie: o token fica no `sessionStorage` da aba e
vai em todo request (limite declarado em `CONSTRAINTS.md` §2.6).

A aba **Filas** (24/09/2026) mostra as duas filas persistentes — inbox
(Asaas → Checkout, RN-39) e outbox (Checkout → contratante, RN-43) —
com filtro por status e um botão por linha: **reenfileirar** (inbox) e
**reenviar** (outbox), sempre com o mesmo id, nunca criando linha nova.
O contador ao lado do nome da aba é o número de linhas `falhou`
esgotadas mais `abandonada` — o que pede gente. A listagem da outbox
não mostra o payload (leva `documento`); a `api_key` de contratante
aparece só pelos 4 últimos caracteres em toda listagem (RN-46).

### 4.4 Termos, Privacidade, 404 e fechar pop-up

Páginas estáticas. **Carregando, vazio, erro, sem permissão e lista
longa não se aplicam** — não consultam nada e não têm estado. A 404 é
servida com status HTTP 404, não 200.

### 4.5 Aprovar troca de plano (`/troca#t=…`)

Nasce em RN-35.2 — só existe quando `POST /trocar-plano` responde `202`.
O token vai no FRAGMENTO da URL, lido uma vez e mantido só em memória
(nunca em storage do navegador); recarregar a página perde o token por
desenho.

| estado | o que aparece |
|---|---|
| Carregando | esqueleto com a geometria RESERVADA do estado final — nunca revela conteúdo depois de um layout diferente (evita o CLS que a tela de assinatura teve em 17/09/2026) |
| Sucesso (pronto) | resumo do acerto: crédito do plano atual, o que o plano novo custa nos dias restantes, e o total a pagar — com o botão "Aprovar cobrança de R$ X,XX" |
| Vazio | **não se aplica** — sempre existe uma intenção por trás do token, ou o estado é erro |
| **Erro / Indisponível** | token ausente, mal formado, ou intenção inexistente: "Link inválido" |
| Link expirado | passou dos 15 minutos (ou da virada do dia civil de Brasília): "Link expirado", sem cobrar nada |
| Link desatualizado (`STALE`) | a assinatura mudou desde que o link nasceu (ex.: outra troca já concluiu): "Link desatualizado", sem cobrar nada — nunca recalcula às cegas |
| Processando | depois de clicar "Aprovar", enquanto o veredito do cartão ainda não fechou: "Confirmando o pagamento", com poll automático |
| Pago, com volta | **não se aplica** — não é um `returnUrl` de pedido; a tela mostra "Troca confirmada" e para ali, sem redirecionar a lugar nenhum |
| Pago, sem volta | **não se aplica**, mesmo motivo |
| Recusado | o cartão salvo recusou o acerto: "Pagamento não aprovado" — a assinatura continua no plano ANTIGO |
| Sem permissão | **não se aplica** — a credencial é o token em si, não um login |
| Lista longa demais | **não se aplica** — a tela mostra só o resumo de UM acerto |

**Nunca deixa escolher plano.** É a restrição central do dono ao pedir
esta tela (20/09/2026): o assinante aprova o valor que o contratante já
calculou, nunca decide para qual plano está indo.

---

## 5. Regras de negócio

Numeradas, com o que vale, o que acontece na violação, e **quem vê**.

**RN-01 · O valor cobrado vem sempre do contratante, nunca do
navegador.** O corpo da requisição aceita apenas nome, e-mail, documento
e telefone. *Violada:* o comprador escolheria quanto paga. *Quem vê:*
ninguém em produção — a suíte `tests/valor-vem-do-servidor.js` falha
antes, e o backend ignora campo de valor no corpo.

**RN-02 · Taxa é somada por cima, nunca descontada do contratante.** O
comprador paga o valor do pedido mais a taxa da Asaas mais a taxa
própria. *Violada:* o contratante recebe menos do que vendeu. *Quem vê:*
o contratante, na conciliação, e o operador na aba Métricas.

**RN-03 · Pedido sem valor cobrável não vira cobrança**, com taxa ligada
ou desligada (`valorValido`: de R$ 0,01 a R$ 100.000). *Violada:* com
taxa, o comprador pagaria só a taxa; sem taxa, uma cobrança de R$ 0,00
entraria na métrica como pagamento que ninguém fez. *Quem vê:* o
comprador, na tela indisponível; o operador, se olhar a métrica.
Detalhe e veto em `CONSTRAINTS.md` §1.11.

**RN-04 · Um pedido tem no máximo uma cobrança pagável por método.**
Recarregar a página e clicar de novo devolve o **mesmo** Pix. *Violada:*
o comprador teria dois códigos igualmente pagáveis e pagaria duas vezes.
*Quem vê:* o comprador, no extrato; o operador, em duas linhas pagas do
mesmo pedido.

**RN-04.1 · Pedido que o nosso banco sabe que foi pago não abre de novo,
diga o contratante o que disser.** Antes de montar a tela ou cobrar (Pix,
boleto, cartão), o checkout confere as próprias cobranças do pedido:
confirmado, em análise, estorno em andamento/parcial/negado ou contestação
→ "Este pedido já foi pago." (409 `pedido_ja_pago`); pop-up de cartão
concluída sem confirmação → 409 `pagamento_em_processamento`. Estorno
total, recusa, vencimento e cancelamento liberam pagar de novo. Sem
resposta do banco, fecha (503). *Violada:* no primeiro dia de produção
(25/09/2026) o contratante de teste esqueceu que dois pedidos foram pagos
e o checkout os reabriu, porque só perguntava a ele. *Quem vê:* o
comprador, que pagaria duas vezes. `tests/pedido-pago-nao-cobra-de-novo.js`.

**RN-51 · O primeiro pagamento de um pedido torna as irmãs obsoletas.**
Quando uma cobrança de um pedido é confirmada (ou já passou por
confirmação: estorno em andamento/parcial/negado, contestação), toda
outra cobrança do MESMO contratante e pedido que ainda pode ser paga —
Pix ou boleto pendente ou vencido, pop-up de cartão aberta ou recusada —
é marcada obsoleta, e o cancelador a invalida na Asaas: lê o estado e só
então exclui a cobrança (`DELETE /v3/payments/{id}`) ou encerra a sessão
(`POST /v3/checkouts/{id}/cancel`). O status local vira
`cancelado_por_outro_pagamento` **só depois de a Asaas confirmar**. Não
invalida: cobrança paga ou em análise (se liquidar, é RN-52), cobrança de
outro pedido ou de outro contratante, e nada quando o único pagamento foi
estornado por inteiro (o pedido volta a poder ser pago). Nada é apagado
do banco. Falha da Asaas vira tentativa gravada com recuo (1, 5, 15 min,
1 h, 4 h, 12 h, 24 h) e para em 8, com aviso ao operador em `erros`; o
pedido continua pago o tempo todo. O webhook dispara na hora; a passada
de minuto em minuto marca pelo ESTADO (pedidos liquidados nos últimos 3
dias), então a liquidação vinda da consulta de status ou do reconciliador
também invalida. O contratante
não recebe aviso sobre a irmã (o pedido está pago), e a consulta, a tela
de status e o `/estornar` por pedido nunca escolhem a irmã cancelada.
*Violada:* o Pix/boleto emitido antes continuaria pagável no app do
banco depois de o pedido ser pago no cartão. *Quem vê:* o comprador, no
extrato, com dois débitos. `tests/pagamento-de-um-pedido-invalida-as-irmas.js`.

**RN-52 · Dois pagamentos reais do mesmo pedido são duplicidade, nunca
um só.** Se uma irmã liquidar mesmo assim (as duas confirmadas quase ao
mesmo tempo, ou paga no instante em que era excluída), os dois registros
ficam como estão — `confirmado`, dinheiro real —, as duas linhas ganham
`pagamento_duplicado_em`/`pagamento_duplicado_com`, o aviso ao
contratante leva `pagamentoDuplicado: true` e `duplicadoCom`, e o
operador recebe uma linha em `erros` ("PAGAMENTO DUPLICADO"). Nada é
estornado sozinho: um dos dois é devolvido pelo fluxo de estorno de
sempre (`POST /api/checkout/estornar` com o `chargeId` da que deve
voltar — sem ele, a rota responde `409 mais_de_uma_cobranca_paga` e
lista os dois — ou o painel da Asaas). *Violada:* um segundo pagamento sumiria da conta ou
seria gravado como cancelado. *Quem vê:* o contratante, que precisa
devolver um; o operador, no painel de erros.

**RN-53 · Cada estorno é uma operação durável, e a mesma chave é o
mesmo estorno.** Desde 25/09/2026 (SEC-002, Estação 6): `POST /estornar`
grava a operação em `estornos` (migration 0018) ANTES de chamar a Asaas,
identificada pela `chaveIdempotencia` do contratante — obrigatória no
parcial, derivada da cobrança no total. Repetir a mesma chave devolve o
resultado gravado e nunca estorna de novo; a mesma chave com outro valor
ou outra cobrança é recusada. Resposta perdida (timeout, 5xx, queda do
processo) deixa a operação em `UNKNOWN_PROVIDER_RESULT`, e só a
reconciliação decide — pelo marcador que viaja na `description` do
estorno e volta em `GET /v3/payments/{id}/refunds` (ou pelo delta exato
do valor, com uma operação em aberto só); ausência só vale como prova
depois de 15 minutos, e o worker de 2 minutos nunca chama o estorno. O
que está em voo conta como estornado na conta do restante, então o
acumulado nunca passa do cobrado. E a cobrança estornada é a que PAGOU,
não a mais recente (SEC-005). *Violada:* cobrança de R$ 100, parcial de
R$ 30 com a resposta perdida, o contratante repete e a Asaas devolve
R$ 60. *Quem vê:* o contratante, que perde o dinheiro; o pagador, que
recebe a mais.

**RN-55 · Instrumento de pagamento só volta se ainda é o instrumento
deste pedido, por este preço.** Desde 25/09/2026 (SEC-004/SEC-005,
Estação 6): `POST /pix` e `/boleto` passam pela guarda de pedido pago
(RN-04.1) e pela cotação ANTES de reaproveitar a cobrança pendente; a
cobrança obsoleta (RN-51) nunca volta; valor diferente do da cotação
exclui o Pix/boleto antigo na Asaas — lendo o estado antes, nunca sobre
o que foi pago — antes de criar o novo. Na pop-up, sessão de outro
valor, parcelas ou ciclo é encerrada antes de abrir outra (PAID não se
substitui; qualquer dúvida é "tente de novo" sem nada novo). E "a
cobrança do pedido" da tela de status e da consulta do contratante é a
que segura dinheiro, depois a pendente vigente, depois a mais recente —
nunca a irmã cancelada. *Violada:* o QR de um pedido já pago no cartão
era devolvido de novo; o pagador via R$ 80 e pagava R$ 100; um pedido
pago aparecia como cancelado. *Quem vê:* o pagador; o contratante na
conciliação.

**RN-54 · Identificador que atravessa fronteira tem uma grafia só.**
Desde 25/09/2026 (SEC-001/SEC-003, Estação 6): `pedidoId`, `planoId`,
`contratanteId` e os ids da Asaas que chegam por URL ou corpo só aceitam
letras sem acento, números, `-` e `_` (até 128) — o resto é `400`, nunca
normalizado. Antes, `%2F`/`%3F` decodificados pelo Express e `..`
resolvido pela `URL` faziam um `pedidoId` adulterado virar outro caminho
de uma requisição autenticada com a chave do contratante (o Checkout
virava proxy de leitura da API dele), e `./ped_1` era o mesmo pedido no
contratante e outra chave no nosso banco — escapando das guardas de
pagamento duplicado (RN-04, RN-04.1, RN-51). As rotas públicas de status
de Pix/boleto só consultam a Asaas para uma cobrança que é nossa e do
método da rota. *Violada:* anônimo lia outros recursos da API do
contratante; o mesmo pedido era pago duas vezes sem detecção. *Quem
vê:* o contratante; o pagador que pagou duas vezes.

**RN-05 · Método não habilitado não cobra.** O contratante declara quais
métodos aceita; o backend recusa os demais mesmo que a requisição peça.
*Violada:* cobrança por um meio que o contratante não combinou. *Quem
vê:* o contratante, ao receber dinheiro por onde não esperava.

**RN-06 · Contratante arquivado ou desativado para de resolver pedido.**
Não é só sumir da lista: o link antigo deixa de gerar cobrança e a chave
dele deixa de autenticar estorno, no mesmo instante. *Violada:* parceiro
desligado continuaria cobrando. *Quem vê:* o comprador, como
"Contratante não encontrado"; o operador, na lista de arquivados.

**RN-07 · Contratante nunca é apagado enquanto tiver cobrança paga.**
*Violada:* histórico financeiro órfão, sem dono, e conciliação
impossível. *Quem vê:* ninguém na hora — é o tipo de dano que só
aparece na auditoria seguinte. Por isso o painel não oferece excluir
(§1.10).

**RN-08 · A `api_key` do contratante se troca por ação própria, nunca de
carona.** A troca é imediata e invalida a anterior no ato. *Violada:*
chave vazada valeria para sempre, ou uma edição de formulário derrubaria
a integração sem aviso. *Quem vê:* o contratante, que para de resolver
pedido até colar a nova; por isso a confirmação diz isso antes.

**RN-09 · Assinatura por Pix Automático não cobra.** O método nasce
desmarcado em contratante novo, porque não está liberado nesta conta
Asaas (§2.4). *Violada:* erro da Asaas no meio do fluxo do assinante.
*Quem vê:* o comprador, no erro; o operador, no log.

**RN-10 · Onde a Asaas define um conjunto fechado, o checkout conhece o
conjunto inteiro.** *Violada:* status ou ciclo desconhecido cai no ramo
errado — é a causa raiz recorrente deste projeto
(`docs/erros/2026-09-10-conjunto-enumerado-pela-metade.md`). *Quem vê:*
o comprador, com estado errado na tela; o operador, na aba Webhook como
`nao_mapeado`.

**RN-11 · Todo campo vindo de fora tem teto de tamanho**, aplicado antes
de normalizar: nome 2–150, e-mail 254, documento 32, telefone 32, CEP 16.
Longo demais é recusa, nunca truncamento. *Violada:* um documento de
100 KB passaria como CPF válido depois da limpeza. *Quem vê:* o
comprador, na mensagem de campo inválido.

**RN-12 · Valor por cobrança: R$ 0,01 a R$ 100.000,00. Parcelamento: 1 a
12.** *Violada:* recusa com "Valor do pedido inválido." *Quem vê:* o
comprador, ao clicar; e a tela nem chega lá, por RN-03.

**RN-13 · Nenhuma mensagem de erro revela nome de tabela, caminho de
arquivo, versão de biblioteca ou rastro de pilha.** *Violada:* mapa da
infraestrutura entregue a quem tentar. *Quem vê:* quem estiver
sondando — e é exatamente quem não deve ver. O detalhe vai para o log
do servidor.

**RN-14 · `apiBaseUrl` e `webhookUrl` do contratante precisam ser https
e de host público.** O backend manda a `api_key` do contratante nesses
endereços e busca o pedido por eles; `http://` vazaria a chave em claro,
e host interno (`localhost`, `169.254.169.254`, faixa privada) faria o
checkout buscar recurso interno da nuvem (SSRF). *Violada:* o cadastro
ou a edição recusa com "precisa ser https e de host público". *Quem vê:*
o operador, no painel. Introduzida no ciclo de segurança da Estação 6
(14/09/2026).

**RN-15 · O `returnUrl` só é honrado se a origem dele pertencer ao
contratante daquele checkout.** A origem do `apiBaseUrl` vale sempre; as
demais entram em `retornoDominios`, cadastradas no painel. A comparação
é por origem exata (`esquema + host + porta`), feita **no servidor** —
o navegador recebe o destino já aprovado e nunca a lista. *Violada:* o
checkout viraria *open redirect* — um link com o nosso domínio na
frente levando a vítima para o site do golpista, com o cadeado certo e a
reputação do domínio que cobra dinheiro por trás. *Quem vê:* ninguém,
no caminho normal: destino fora da lista é ignorado em silêncio e o
pagamento segue igual. Protegida por
`tests/retorno-nao-vira-open-redirect.js`, que falha se alguém voltar a
decidir o destino no front ou ecoar o parâmetro cru. Introduzida em
15/09/2026, na Estação 6.

**RN-17 · Quem vincula a cobrança do pop-up é o evento de pagamento,
não o de checkout.** A Asaas não manda o id do pagamento no
`CHECKOUT_PAID` (medido em 15/09/2026 nos payloads crus); ele chega no
`PAYMENT_CONFIRMED`, com `payment.checkoutSession` apontando de volta.
É lá que `charge_id` e `asaas_subscription_id` são gravados. *Violada:*
a cobrança fica `confirmado` com `charge_id` nulo, o
`/cancelar-assinatura` não acha o que cancelar, e **todo ciclo seguinte
da assinatura é descartado em silêncio** — foi o que aconteceu até
15/09. *Quem vê:* o contratante, que nunca recebe `cobranca_confirmada`;
e o assinante, cuja conta nunca ativa. Protegida pelo autoteste do
`webhookController`, que reproduz a sequência real dos dois eventos.

**RN-18 · Aviso de pedido sem `chargeId` não é enviado.** O payload de
pedido carrega `chargeId`, e é por `chargeId` + `status` que o
contratante deduplica (`API.md` §4.3.6): um aviso sem esse campo não é
verificável nem deduplicável. Quando o `CHECKOUT_PAID` não tem o id, o
aviso sai no `PAYMENT_CONFIRMED`, com o id verdadeiro. *Violada:* o
contratante recebe uma confirmação que não consegue conferir — e ou
recusa creditar (correto, e foi o que o MostrAí fez) ou credita às
cegas. *Quem vê:* o contratante. **Assinatura não entra nesta regra:** o
evento `criada` não carrega `chargeId` por contrato, a chave dele é
`planoId` + `documento`.

**RN-19 · Assinatura pausada continua cancelável.** O
`/cancelar-assinatura` aceita `ativa` e `pausada`; `cancelada` fica de
fora (a busca devolve a mais recente, e numa renovação aceitar
`cancelada` poderia mascarar uma ativa mais nova). *Violada:* pausar
vira porta de mão única — quem pausa nunca mais cancela, e a assinatura
fica `INACTIVE` na Asaas sem saída pela API, só pelo painel na mão.
*Quem vê:* o contratante, que recebe 404 ao tentar cancelar o que ele
mesmo pausou. Medido ao vivo em 15/09/2026 — a mesma linha respondia 200
no pausar e 404 no cancelar. Protegida por
`tests/assinatura-pausada-continua-cancelavel.js`, que cobra a regra
("tudo que pausar alcança, cancelar alcança"), não o literal.

**RN-20 · Renovação abandonada nunca notifica `cancelada`.** Fechar o
pop-up de troca de cartão (`&renovar=1`) sem pagar deixa a assinatura
ANTIGA intocada, ainda ativa e sendo cobrada — `encerrarAssinaturaSubstituida`
só roda depois que o pagamento novo confirma. *Violada:* o payload de
assinatura é identificado só por `planoId`+`documento` (API.md §4.3.4),
então o contratante não tem como distinguir "renovação abandonada" de
"o cliente cancelou de verdade" — as duas produzem o mesmo evento, pro
mesmo assinante. Um contratante que confia nisso pra liberar/revogar
acesso revogaria de quem ainda está pagando. *Quem vê:* o cliente que
tentou trocar o cartão e desistiu, barrado sem nunca ter cancelado nada.
Achado em 15/09/2026, na auditoria do caminho da assinatura; assinatura
NOVA (não-renovação) abandonada continua mandando `cancelada`, como
documentado (API.md §4.3.5) — só a renovação muda.

**RN-21 · `/cancelar-assinatura` notifica o contratante, não só a
resposta síncrona.** Até 16/09/2026 o cancelamento pedido pelo próprio
contratante mudava a Asaas e o nosso banco, mas nunca mandava
`evento: cancelada` pro `webhook_url` — só a resposta HTTP confirmava.
*Violada:* o `API.md` §7.4 desenha essa seta desde antes de existir de
verdade; um contratante que dependesse do webhook (em vez de só ler a
resposta síncrona) nunca saberia que o cancelamento aconteceu. *Quem
vê:* o contratante. Corrigido com `notificarAssinaturaCancelada`
(webhookController.js), fire-and-forget, mesmo canal que os outros dois
desfechos de `cancelada` (pop-up de renovação abandonada, autorização
de Pix Automático encerrada) já usavam. Protegida por checagem no
texto-fonte de `assinaturaController.js` (verificado por sabotagem).

**RN-22 · Conciliação não pode confundir tentativa de renovação com o
ciclo real.** `POST /consultar-assinatura` (§5.3) busca a "última
cobrança" por `contratanteId+planoId+documento`, ordenando por
`criado_em`. Uma tentativa de renovação (`&renovar=1`) nasce DEPOIS do
último ciclo real e tem `substitui_assinatura_id` apontando pra
assinatura antiga. *Violada:* sem tratamento, uma tentativa abandonada
(`cancelado`/`expirado`) aparecia como `ultimaCobranca` de uma
assinatura que continua `ativa` e cobrando normalmente — e a primeira
correção trocou esse furo por outro: exigir `status = 'confirmado'`
exato escondia uma renovação que confirmou e **depois foi estornada**.
*Quem vê:* o contratante que roda a conciliação diária (checklist
`API.md` §11). Corrigido em `buscarUltimaCobrancaDaAssinatura`
(cobrancaService.js): só é descartada a linha de renovação cujo status
significa "nunca chegou a acontecer" (`pendente`, `cancelado`,
`expirado`); qualquer resultado real (confirmado, estornado, em
análise…) conta. Achado e corrigido em 16/09/2026, numa varredura
focada em achados graves.

**RN-23 · Entrega duplicada do mesmo webhook não pode notificar o mesmo
ciclo duas vezes.** A Asaas pode reenviar o mesmo `PAYMENT_CONFIRMED`
(`API.md` §4.3.6, "pode chegar mais de uma vez"). Pra um ciclo NOVO (2º
mês em diante), duas entregas quase simultâneas liam a cobrança como
inexistente antes de qualquer uma terminar de inserir a linha — a
`unique` de `charge_id` barrava a segunda inserção no banco, mas nada
sinalizava isso pra cima, e a entrega perdedora seguia em frente e
notificava de novo o MESMO ciclo. *Violada:* o payload de assinatura
não carrega `chargeId` (RN-18), então o contratante não tinha nenhum
campo pra perceber que a segunda notificação era repetida — creditaria
o ciclo duas vezes. *Quem vê:* o contratante, em silêncio. Corrigido:
`registrarCicloAssinatura` detecta a violação do `unique` (código
Postgres `23505`) e sinaliza `duplicado`; a entrega perdedora não
notifica nada, confiando que a vencedora já cuidou disso. Achado e
corrigido em 16/09/2026, verificado por sabotagem.

**RN-24 · Pop-up bloqueada não pode travar o botão pra sempre.** Cartão
avulso e assinatura por cartão abrem a pop-up hospedada da Asaas com
`window.open`, chamado DEPOIS de um `await` — o que quebra o "gesto do
usuário" em vários navegadores/bloqueadores e faz `window.open`
devolver `null`. *Violada:* sem checar isso, nenhum listener de
fechamento era armado, o polling ficava rodando pra sempre esperando
uma confirmação que nunca chegaria (o pagador nunca viu a tela), e o
botão ficava preso em "Abrindo pagamento…", desabilitado, sem toast e
sem saída além de recarregar a página. *Quem vê:* o comprador com
bloqueador de pop-up ativo, ou no Safari. Corrigido em
`cartaoHandler.js` e `assinaturaCheckoutHandler.js`: toast pedindo pra
liberar pop-ups e o botão reabilitado. Achado em 16/09/2026.

**RN-25 · Renovação exige token — `documento` sozinho nunca basta.**
`POST /api/checkout/assinatura/:contratanteId/:planoId` é pública (sem
`X-Checkout-Key`); até 16/09/2026, `renovar: true` bastava sozinho pra
achar a assinatura antiga só pelo `documento` do formulário — não
autenticado. *Violada:* CPF/CNPJ não é segredo; qualquer pessoa que
soubesse o documento de um assinante ativo criava uma assinatura nova
com o PRÓPRIO cartão e, ao confirmar o pagamento, o checkout cancelava
a assinatura de VERDADE da vítima na Asaas — um cancelamento de
terceiro pelo caminho de dinheiro, contrariando o `API.md` §5.5
("cancelamento: só o projeto aciona"). *Quem vê:* o assinante vítima,
que perde a assinatura sem ter feito nada; o contratante, que vê uma
cobrança de estranho na conta de outro cliente. Corrigido: `renovar`
agora precisa ser um token HMAC-SHA256 que só quem tem a `api_key` do
contratante consegue gerar (`utils/tokenRenovacao.js`, `API.md §7.3`,
com receita em Node/PHP/Python). Sem token válido, degrada pra
assinatura nova comum — nunca amarra nem cancela nada. **Mudança
incompatível**: `&renovar=1` (o formato antigo) para de funcionar como
renovação. Achado e corrigido em 16/09/2026, testado com sabotagem.

**RN-26 · A conciliação reconfere a assinatura na Asaas, não só a
cobrança.** `POST /consultar-assinatura` (§5.3) consulta
`GET /v3/subscriptions/{id}` e corrige o registro local quando diverge;
também é de lá que sai `proximaCobranca` (`nextDueDate`), que era `null`
desde sempre. *Violada:* se uma chamada nossa de cancelar/pausar/retomar
estourar o timeout DEPOIS de a Asaas ter processado (só a resposta
perdida), `atualizarStatusAssinatura` nunca roda e o banco fica dizendo
`ativa` pra sempre enquanto a Asaas já cancelou — divergência sem
nenhum caminho de detecção. *Quem vê:* o contratante, que segue
liberando acesso pra quem não paga mais. O `404` da Asaas **não** vira
`cancelada` automática (também é o que responde id de outra conta), e
falha de rede não derruba a conciliação — cai pro dado local. Corrigido
em 16/09/2026, com tratamento defensivo dos dois formatos que a doc da
Asaas não esclarece (objeto com `deleted: true`, ou `404`).

**Medido no mesmo dia**, rodando o `GET` de dentro do container de
produção contra uma assinatura cancelada de verdade: a Asaas usa o
primeiro formato — `200` com `deleted: true` e `status: "INACTIVE"`,
que é **o mesmo status de uma pausada**. Por isso a regra olha `deleted`
ANTES do status: a ordem inversa marcaria toda cancelada como `pausada`.

**RN-26.1 · O `ciclo` divergente é corrigido pelo da Asaas.** A mesma
consulta traz `cycle`, e quem cobra é a Asaas: divergência aí é erro
nosso. *Violada:* toda assinatura criada antes de 15/09/2026 ficou
gravada como `MONTHLY`, qualquer que fosse o plano — o código lia um
campo de webhook que não existe
(`docs/erros/2026-09-15-ciclo-de-assinatura-nao-vinha-de-webhook-nenhum.md`).
A correção de origem só valeu pras novas; sem esta regra as antigas
ficariam erradas para sempre. Medido em 16/09: `sub_qut6521d50496vkn`
estava `YEARLY` na Asaas e `MONTHLY` aqui. *Quem vê:* o contratante, que
lê `ciclo` na conciliação e mostra "mensal" pra quem assinou anual.

**RN-16 · A volta ao contratante nunca carrega status de pagamento.** A
URL de retorno leva só o `pedido`; `status`, `pago` e equivalentes são
proibidos por construção. *Violada:* o integrador leria `?status=pago`
da barra de endereço e entregaria o produto para quem digitasse isso à
mão. *Quem vê:* ninguém — quem confirma pagamento é o webhook assinado
ou a consulta autenticada, e o `API.md` §3.1 diz isso em destaque.

**RN-27 · Todo 5xx vira linha, e linha igual soma em vez de repetir.**
Exceção que o servidor devolve como 5xx é capturada com o contexto da
requisição e fica 30 dias (`erros`, migration 0007). *Violada:* o erro
que importa acontece daqui a três semanas, às duas da manhã, num
webhook — e o log do painel da hospedagem tem retenção curta, então
quando alguém for procurar já não está lá. *Quem vê:* o operador, na aba
Erros. Três limites fazem parte da regra: **agrega por impressão
digital** (senão uma rota pública que dá 500 vira escrita ilimitada no
banco para quem só descobriu a URL); **só 5xx** (validação recusada é o
sistema funcionando, e gravá-la apaga o sinal); e **nada de pessoa
entra** — a mensagem é raspada e corpo, cabeçalho e URL com valores
nunca entram (`docs/inventario-de-dados.md` §7.2).

**RN-28 · O piso de R$ 5,00 é dito ao abrir a tela, não no clique.**
A Asaas recusa qualquer cobrança abaixo de R$ 5,00 no valor cobrado —
medido em 17/09/2026 nos seis caminhos de criação, com controle positivo
em R$ 5,00 exato (`API.md` §9.1). Quem decide é o servidor, nas duas
rotas que abrem tela (`GET /pedido/…` e `GET /plano/…`), que passam a
devolver `bloqueio` com a frase pronta; as cinco rotas que criam cobrança
repetem o guarda, porque a tela não é a única porta. *Violada:* o
comprador preenche nome, e-mail, CPF, telefone — e, no cartão, endereço
inteiro, que a Asaas exige por antifraude — para receber no fim um erro
escrito em linguagem de provedor sobre um link que nunca ia funcionar.
*Quem vê:* o comprador, na abertura da tela. O texto do piso mora no
servidor e não é repetido no front de propósito: duplicado, um dia o
número muda num lugar só e a tela passa a mentir.

**E o piso vale POR PARCELA no cartão** — achado no ciclo 5 da revisão,
porque a primeira medição tinha sido feita só com uma parcela. R$ 24,00
em 12x dá R$ 2,00 por parcela e a Asaas recusa a cobrança; mas a
**sessão** da pop-up é aceita, então sem correção a recusa só apareceria
lá dentro, com o cartão já digitado. A correção **não recusa a venda:
oferta menos parcelas** (R$ 24,00 fecha em R$ 26,15 e sai em até 5x de
R$ 5,23), e a taxa cobrada passa a ser a da faixa ofertada, não a da
pedida — capar depois da taxa seria pior que não capar, porque o
comprador pagaria a faixa de 7-12x podendo usar só 5x. E a **tela
também corta a lista**, com o número que o servidor manda
(`maxParcelas`): sem isso ele escolheria 12x aqui e veria 5x na pop-up.
`taxaService.taxaComParcelasQueCabem`, `API.md` §9.1.

**RN-29 · O telefone é recusado pela regra MEDIDA da Asaas, não pela
suposta.** `docs/pendencias.md` dizia que a Asaas recusa "número de
dígito repetido"; 24 combinações medidas em 17/09/2026 mostram que não —
`11988888888` e `11911111111` passam. As regras reais são DDD ≥ 11,
celular começando em 9, e a parte depois do DDD não ser um único dígito
repetido (`API.md` §9.2). *Violada:* de um lado, `11999999999` atravessa
o checkout e só a Asaas recusa, no clique; do outro, um validador escrito
contra a frase errada recusaria números legítimos no caminho do dinheiro.
*Quem vê:* o comprador, no campo de telefone. O que a Asaas aceita e o
Brasil não (DDD `20`, prefixo de fixo `1` ou `6`) **passa aqui também** —
recusar o que o provedor aprova é bloquear comprador de verdade.

**RN-30 · A resposta do contratante não pode virar o alvo, nem encher a
memória.** O pull revalida cada redirecionamento (só mesma origem, no
máximo 3 saltos) e lê o corpo com teto de 1 MiB, contando o que chega em
vez de acreditar no `Content-Length`. *Violada:* o `fetch` seguia
redirect sozinho, então um contratante malicioso ou comprometido
responderia `302` para `http://169.254.169.254/…` e o checkout buscaria a
credencial da nuvem — a checagem de cadastro (RN-14) não vê isso, porque
o endereço cadastrado continua público e https; quem trocou o alvo foi a
resposta. E como a requisição leva a `X-Checkout-Key` do contratante,
seguir para outra origem entregaria a credencial de consulta e estorno
dele a quem respondeu o `Location`. Do outro lado, `resposta.json()` lia
até o fim: um corpo de alguns giga derrubaria a instância de 512 MiB e,
com ela, a confirmação de pagamento de TODOS os contratantes — o mesmo
dano do `fetch` sem timeout de 15/09. *Quem vê:* o comprador vê a mesma
mensagem de "não foi possível carregar", e o operador vê o motivo no
diagnóstico; a diferença que importa é que o `502` diz "resposta errada
do contratante" e o `504` diz "rede fora do ar".

**RN-31 · Dado pessoal vence em cinco anos, e quem decide o que fica é
uma lista branca.** A rotina anonimiza (não apaga) as colunas pessoais de
cobranças e de assinaturas canceladas depois do prazo de
`docs/inventario-de-dados.md` §6, no ciclo de 24 h, e atende pedido do
titular (LGPD art. 18) respeitando a guarda fiscal — dizendo quantas
linhas ficaram retidas e quando elas liberam, em vez de responder
"feito". *Violada:* o prazo declarado sem rotina é intenção, não prática
— foi o estado do projeto até 17/09/2026. E se a regra fosse uma lista do
que SAI, uma coluna pessoal criada depois sobreviveria para sempre a cada
vez que alguém esquecesse de atualizar o arquivo; por isso a lista é do
que FICA, e o autoteste a confere contra as colunas reais do banco.
*Quem vê:* ninguém, no dia a dia — é o tipo de regra cuja evidência é o
autoteste e a simulação, não a tela. `npm run expurgo` mostra o que ela
faria sem escrever nada.

**RN-32 · O documento é UMA chave só: dígitos.** Toda fronteira que
aceita `documento` normaliza para dígitos logo depois de validar, e daí
para baixo só existe essa forma. *Violada:* `552.085.198-01` e
`55208519801` são o mesmo CPF e passam os dois na validação — gravados
como vêm, viram duas chaves diferentes. Como a assinatura é localizada
por `contratante_id + plano_id + documento` (`API.md` §5.5), quem
assinasse mandando o CPF pontuado e depois pedisse cancelamento mandando
só dígitos receberia `404`: assinatura que existe, está cobrando, e não
pode mais ser cancelada pela API — o mesmo desfecho do furo de "pausar
era porta de mão única", por outra porta, e valendo nos dois sentidos.
*Quem vê:* quem tenta cancelar e não consegue; e o operador, no
suporte, sem pista do motivo. Passava despercebido porque a máscara do
front tira a pontuação antes de enviar — as 13 linhas em produção eram
todas só dígitos, medido —, mas a máscara é do navegador e a API é
pública. Achado em 17/09/2026 pelo ciclo da skill `revisar`, enquanto se
escrevia a rotina de expurgo, que precisava casar documento para
atender pedido de titular.

**RN-33 · A métrica conta negócio, e uso interno não é negócio.** Toda
cobrança nasce com `ambiente` (de qual ambiente da Asaas ela veio) e
`e_teste` (marcação de uso interno), e a métrica de sucesso só soma a
linha em que `ambiente = 'producao'` **e** `e_teste = false`. O
`ambiente` vem da configuração do processo (`src/config/asaas.js`),
nunca do corpo da requisição — quem paga não escolhe em que ambiente a
própria cobrança nasceu. E `e_teste` é de **mão única**: vai de teste
para real e não volta, travado por gatilho no banco
(`supabase/migrations/0009_ambiente_e_teste.sql`), porque o caminho
inverso apagaria da conta um resultado de negócio já contado, e
apagaria em silêncio. *Violada:* o pagamento que o dono faz para
exercitar o fluxo entra na conta como cobrança confirmada de verdade —
e a métrica de sucesso do projeto, que é "quantas confirmadas ontem,
por contratante" (seção 9), passa a medir a própria casa. Depois da
troca para produção, com dinheiro real entrando no mesmo banco das
cobranças de teste, o número erraria no primeiro dia e não haveria como
saber de quanto. *Quem vê:* o operador, na aba Métricas do painel — que
mostra o que ficou de fora num cartão próprio ("Fora da conta"), porque
exclusão silenciosa é indistinguível de dado que não existe: com dez
cobranças de sandbox no banco, "Nenhuma cobrança no período" seria uma
frase falsa. Por isso a aba tem **dois vazios diferentes**: "não houve
cobrança" e "houve, e nenhuma era de negócio". A soma confere — entrou
mais excluído é igual ao lido do banco, conferido por autoteste e
medido contra o banco de produção em 17/09/2026 (10 linhas lidas, 10
excluídas, 0 de negócio).

**RN-34 · O valor de uma assinatura pode mudar na Asaas, e a conciliação
corrige o nosso registro e DENUNCIA a diferença.** A Asaas **aceita**
alterar `value` e `cycle` de uma assinatura ativa — medido no sandbox em
17/09/2026, em cartão e em boleto. Para o caso legítimo existe a troca de
plano (RN-35). Esta regra é sobre o caso que **não passa por nós**:
alteração feita pelo painel da Asaas ou por API direta. O checkout **não
age na hora** — medido em 17/09/2026, nenhum evento chegou ao receptor
em toda a bateria, porque `SUBSCRIPTION_*` não estava entre os eventos
configurados naquele dia. ⚠️ Isso mudou em 18/09/2026: o dono marcou o
grupo (`CONSTRAINTS.md` §2.2), então o evento **passa a chegar** —
`PAYMENT_UPDATED` continua desmarcado de propósito. O que não muda é o
efeito: o código ainda não trata `SUBSCRIPTION_*` (cai como não
mapeado, só vira log), então nem o nosso registro é corrigido nem o
contratante é avisado por esse caminho — a correção segue vindo pela
conciliação (pull), até alguém tratar o evento em código.

O que a conciliação (`API.md` §5.3) faz desde **18/09/2026**, por decisão
do dono: reconfere `valor` junto de `status`, `ciclo` e
`proximaCobranca`; achando diferença, **devolve o valor da Asaas**,
**grava a correção** e **devolve `divergenciaDeValor: { nosso, asaas }`**
na mesma resposta. Comparação em **centavos**, senão ponto flutuante
inventa divergência e a "correção" reescreve a linha a cada conciliação.

*Violada de um jeito:* sem reconciliar, `assinaturas.valor` fica o antigo
para sempre e o contratante mostra ao assinante um preço que não é o
cobrado — é a MESMA família do bug do `ciclo` de 15/09, e a correção de
16/09 fechou `ciclo` e deixou `valor` aberto até aqui. *Violada do
outro:* corrigir **calado** trocaria um número errado por uma mudança
invisível — o contratante é quem fala com o assinante (RN-35), e ele
precisa saber que o preço mudou fora do fluxo. *Violada de um terceiro:*
anular o nosso valor quando a Asaas não devolve `value` seria a classe
"ausência virou zero", que este projeto já pagou duas vezes na tela;
sem valor da Asaas, o nosso é mantido.

*Quem vê:* o contratante, em `valor` (corrigido) e em
`divergenciaDeValor` (o evento). **Não há aviso proativo:** ele descobre
**quando roda a conciliação**, e é por isso que o "rode uma vez por dia"
do `API.md` §5.3 ganhou mais um motivo.

> **A decisão foi do dono, em 18/09/2026**, sobre uma declaração que eu
> havia deixado aberta em 17/09 ("reconciliar é deixar a Asaas mandar no
> número, inclusive quando a alteração de lá foi erro humano"). Ele
> mandou reconciliar e me deu a recomendação de fechar se eu achasse
> errado. Não acho: quem debita o cartão é a Asaas, então o nosso número
> divergente não é uma opinião — é informação falsa, e guardá-la para
> "não endossar o erro" só troca um erro de preço por um erro de
> registro. O cuidado que ele queria cabe inteiro na denúncia, e é por
> isso que as duas coisas entraram juntas.

**RN-35 · Trocar de plano cobra a diferença, e avisar o assinante que a
troca ACONTECEU é obrigação do contratante.** Autorizada pelo dono em
17/09/2026, com as sete regras do acerto decididas por ele; o CAMINHO de
cobrança foi revisto em 21/09/2026 (RN-35.2, abaixo).
`POST /api/checkout/trocar-plano` (`API.md` §5.6) leva o assinante do
plano A para o plano B **mantendo o vínculo**, e a ordem é a regra:
o plano de destino é **puxado da API do contratante** (valor e ciclo
nunca vêm do corpo da requisição); quando há acerto, ele é **cobrado no
cartão já salvo** (depois de aprovado — RN-35.2); e **o plano só muda se
o acerto for aprovado no cartão**. Para baixo não cobra e **não
devolve** — o preço novo vale no vencimento que já estava marcado, que a
Asaas não move nem quando o ciclo muda (medido). Acerto abaixo do piso de
R$ 5,00 é **absorvido**, nunca arredondado para cima. *Violada de um
jeito:* alterar o plano antes de cobrar daria o plano caro de graça a
quem tem cartão recusado. *Violada do outro:* confiar no `200` do `PUT`
gravaria "trocou" no nosso banco sobre uma alteração que a Asaas ignorou
em silêncio — ela responde `200` para campo que não conhece, medido, e
por isso a assinatura é **relida** depois. *Quem vê:* o contratante, no
`evento: 'plano_trocado'` — que só dispara quando a troca CONCLUI, seja
na hora (sem acerto) ou depois da aprovação (com acerto) — e traz
crédito, débito e dias restantes. **Avisar que a troca aconteceu não é
função do Checkout:** ele não manda e-mail nem WhatsApp com o resumo
(não há biblioteca de e-mail no `src/`) — isso é obrigação de cada
projeto contratante, decisão do dono, escrita em `API.md` §5.6 e no
checklist da §11. O que o Checkout PASSOU a fazer, desde RN-35.2, é
diferente: pedir o consentimento da COBRANÇA, não avisar do resultado.

**RN-35.2 · Havendo acerto a cobrar, o ASSINANTE aprova o valor antes de
qualquer cobrança — decisão do dono em 20/09/2026, revertendo a de
17/09/2026 ("não existe tela").** O dono testou o MostrAí e viu a troca
acontecer sem o assinante ver nada; achou errado mudar o valor que um
cartão salvo vai cobrar sem consentimento explícito de quem paga (CDC).
Desde 21/09/2026: quando `acerto.cobra` é verdadeiro (>= R$ 5,00),
`POST /trocar-plano` **não cobra mais nada na própria chamada** — cria
uma intenção com o retrato do acerto CONGELADO (migration 0011,
`intencoes_troca_plano`) e devolve `202` com um link (`API.md` §5.6). O
assinante abre `/troca#t=…`, vê o valor exato (nunca escolhe plano — só
aprova o número) e aprova ou não. Só então o cartão é cobrado.
*Violada:* voltar ao comportamento antigo reabriria exatamente a queixa
do dono — cobrança sem consentimento visível de quem paga. *Quem vê:* o
assinante, na tela; o contratante, no `evento: 'plano_trocado'`, que
agora pode chegar minutos depois da chamada original, nunca na mesma
resposta HTTP quando há acerto. **Sem aprovação, nada é cobrado** — o
link expira sozinho em 15 minutos (ou na virada do dia civil de
Brasília, o que vier primeiro) sem tocar o cartão. O token vai no
FRAGMENTO da URL (nunca query string — não viaja em log de acesso nem
`Referer`), é lido uma vez e fica só em memória no navegador (nunca
`sessionStorage`/`localStorage` — este domínio carrega o Web Analytics
da Cloudflare, terceiro não auditado quanto a acesso a storage).
Desenho completo, com as quatro rodadas de decisão e os contrapontos
considerados: `docs/specs/2026-09-20-troca-de-plano-redireciona-
pagador.md`.

**RN-35.1 · Depois da troca, quem manda é a assinatura, não o plano.**
A troca tira do `plano_id` a estabilidade que todo o resto do sistema
assumia (é a chave de cancelar, pausar, retomar, conciliar e do webhook
de assinatura, `API.md` §4.3.4). Três lugares dependiam disso e foram
corrigidos na revisão, antes de ir ao ar: a segunda troca dentro do mesmo
período (o ciclo pago está sob o plano antigo), o ciclo seguinte à troca
(que se monta copiando a cobrança anterior e nasceria com o plano velho —
para sempre, porque cada ciclo copia do anterior) e a conciliação (que
diria "nenhuma cobrança" para uma assinatura que já cobrou). Todos
passaram a ancorar no **id da assinatura**. *Violada:* o contratante
credita o plano que o assinante deixou de ter, a cada cobrança, sem
sintoma. *Quem vê:* ninguém, até alguém comparar o acesso com a fatura.
`docs/erros/2026-09-17-uma-chave-que-era-estavel-deixou-de-ser.md`.

**RN-36 · Duas cobranças do mesmo acerto não acontecem — nem duas
chamadas simultâneas, nem duplo clique no mesmo link, nem o webhook e o
sweeper resolvendo ao mesmo tempo.** Duas camadas, desde 21/09/2026: (1)
a INTENÇÃO só cobra uma vez — a transição de estado que dispara a
cobrança é um `UPDATE` condicional (CAS) em `intencoes_troca_plano`, e
só quem vence a corrida chega a chamar a Asaas; (2) a ASSINATURA continua
com o arrendamento de sempre (`assinaturas.trocando_em`, migration 0010)
durante a janela ativa de cobrança, o mesmo mecanismo da troca síncrona
(sem acerto) de 17/09/2026. *Violada:* sem a primeira camada, um duplo
clique ou o webhook chegando durante o poll do assinante cobrariam o
mesmo acerto duas vezes; sem a segunda, duas trocas da MESMA assinatura
correndo juntas colidiriam. *Quem vê:* a chamada perdedora não cobra
nada — reconsulta o que a vencedora já fez. Medido dentro do contêiner
em 17/09/2026 (a versão síncrona do arrendamento, ainda em uso): 1ª
reivindicação ganha, 2ª não ganha, e um arrendamento de minutos atrás
volta a poder — o prazo curto existe para que um processo que morra no
meio não tranque a assinatura para sempre. O acerto também **não conta
como "última cobrança da assinatura"** na conciliação (`API.md` §5.3):
ele carrega o mesmo `plano_id` e nasce depois do ciclo, e sem o filtro de
método o contratante leria o acerto de R$ 30 como se fosse o preço do
plano — medido com as duas consultas lado a lado.

**RN-37 · Uma cobrança só é estornada uma vez, e só quando está
`confirmado`.** Desde 22/09/2026 (achado de auditoria externa):
`POST /checkout/estornar` reivindica a cobrança por um arrendamento
(`cobrancas.estornando_em`, migration 0013) num `UPDATE` condicional que
só encontra linha quando `status = 'confirmado'` — mesmo mecanismo do
RN-36, aplicado ao estorno. Uma falha da Asaas que não prova
definitivamente que nada foi feito (timeout, 5xx, limite de taxa) nunca
libera o arrendamento — só recusa limpa (4xx com motivo reconhecido)
libera, porque só aí é seguro tentar de novo. *Violada:* duas chamadas
simultâneas (ou um clique duplo) estornariam a mesma cobrança duas
vezes, ou uma tentativa estornaria uma cobrança que nunca foi paga ou já
foi estornada. *Quem vê:* o contratante, como `409` na resposta —
"esta cobrança não pode ser estornada agora".
`docs/erros/2026-09-22-estorno-nao-checava-status-nem-tinha-guarda-de-corrida.md`.

**RN-38 · Cancelar, pausar e retomar uma assinatura se excluem
mutuamente entre si e contra uma troca de plano em andamento.** Desde
22/09/2026 (mesma auditoria do RN-37): as três reivindicam o MESMO
arrendamento que a troca de plano já usa (`assinaturas.trocando_em`,
migration 0010) antes de chamar a Asaas — ele deixou de ser exclusivo
da troca, virou o mutex de qualquer operação que muda uma assinatura.
Diferente do RN-37, nenhuma das três cobra dinheiro, então uma falha na
Asaas **sempre** libera o arrendamento, mesmo ambígua — não há "será
que já cobrou" a proteger; se a Asaas processou mesmo assim, é a
conciliação por pull (§5.3) que corrige depois. *Violada:* duas
chamadas concorrentes (entre si, ou contra uma troca de plano com
acerto pendente) agiriam sobre um estado que já mudou debaixo delas —
o caso mais caro sendo cancelar no meio de uma troca com acerto ainda
não aprovado. *Quem vê:* o contratante, como `409` — "já existe outra
operação em andamento".
`docs/erros/2026-09-22-cancelar-pausar-retomar-nao-tinham-guarda-de-corrida.md`.

**RN-39 · O evento da Asaas é guardado antes de ser respondido, e
processado a partir do guardado.** `POST /api/webhooks/asaas` grava o
corpo mínimo em `webhook_inbox` (idempotente pelo `id` do evento), só
então responde `200`, e processa a partir da linha — inline, para
preservar a ordem que a Asaas garante em `SEQUENTIALLY`; falhou, um
worker reprocessa com recuo, e o operador vê e reenfileira no painel
(aba Filas). O `200` só não sai quando a inbox não grava (`503`, e a
Asaas reenvia). *Violada:* um erro no processamento virava `200` e o
evento sumia — pagamento confirmado na Asaas e `pendente` aqui, para
sempre. *Quem vê:* o comprador (pagou e nada libera) e o contratante
(nunca avisado). Auditoria de 24/09/2026, C-01.

**RN-40 · Toda mudança de status passa pela máquina de estados, com
carimbo.** `transicoesFinanceiras.js` diz de qual status se vai para
qual; o `dateCreated` do evento fica em `status_evento_em`, e um evento
anterior ao que gravou o status atual não regride nada; a escrita é
condicional (`where status = <o que li>`), e quem perde a corrida
relê. Vale para `PAYMENT_*` e `CHECKOUT_*`. *Violada:* um
`PAYMENT_CONFIRMED` atrasado depois de um `PAYMENT_REFUNDED` devolvia a
cobrança a `confirmado`; um `CHECKOUT_PAID` reprocessado no painel
fazia o mesmo. *Quem vê:* o contratante, que libera de novo o que foi
devolvido. C-03.

**RN-56 · O evento de pagamento diz "olhe"; quem diz o que aconteceu é
a Asaas.** Todo `PAYMENT_*` tratado pergunta `GET /v3/payments/{id}`
antes de mexer em dinheiro. A cobrança tem de existir nesta conta (404 →
nada aplicado, linha em `erros`); o vínculo (`externalReference`,
`checkoutSession`, assinatura, parcelamento) e o valor vêm da resposta
DELA, nunca do corpo; e a linha achada pelo `charge_id` tem de ser a que
a Asaas reconhece (referência ou sessão diferente → nada aplicado).
Transição que move dinheiro exige respaldo: `confirmado` só com a
cobrança paga lá (ou num estado que implica que foi paga), estorno só
com o estorno lá, contestação só com a contestação lá; sem respaldo o
evento é tentado de novo pela inbox e, esgotado, vira `erros`. Não
conseguir perguntar também é tentar de novo — nunca "confirmado".
Confirmação de valor diferente do cobrado (pedido avulso sem parcela)
não confirma sozinha. A ordem: um evento que aponta para trás de um
estado que a Asaas confirma é histórico e se ignora (a liquidação D+30
de um cartão em disputa não tira a cobrança de `chargeback`); um evento
cuja transição ainda não se aplica, com a Asaas À FRENTE do estado
local, é estado anterior faltando — lança, e a inbox o reaplica depois
do que falta, em vez de descartá-lo como obsoleto. Com a Asaas já no
estado que o evento aponta, o carimbo não o descarta; carimbo no futuro
vale "agora", e o gravado nunca anda para trás. Um segundo pagamento
na Asaas com a referência de uma reserva já paga é denunciado em
`erros` (RN-52), nunca ignorado. A origem é conferida contra a lista
oficial de IPs da Asaas: fora dela, com token válido, vira `erros`; a
recusa (`403`) só com `ASAAS_WEBHOOK_IP_ESTRITO=1`, porque a origem real
das entregas atrás do proxy ainda não foi medida. *Violada:* com o token
do webhook vazado, um `PAYMENT_CONFIRMED` com um `payment.id` real
confirmava a cobrança sem pagamento e avisava o contratante; um
`PAYMENT_REFUNDED` chegando antes da confirmação era descartado e a
cobrança ficava paga com o dinheiro devolvido. *Quem vê:* o contratante
(libera o que não foi pago; mantém o acesso de quem foi reembolsado) e o
dono (a métrica conta dinheiro que não existe). SEC-007, SEC-008,
SEC-019 da Estação 6.

**RN-57 · Divergência com a Asaas tem dono, e ele é dirigido.** O
reconciliador de divergências (a cada 15 min) olha só as cobranças com
SINAL — evento de pagamento que esgotou a inbox nos últimos 14 dias,
`em_analise` parada há mais de 1 dia, `estorno_solicitado` há mais de 3,
`pendente` com a sessão da pop-up concluída há mais de 1 —, no máximo 20
por passada, e nunca varre a base. Para cada uma, leva a cobrança ao
estado da Asaas pelos passos que a máquina permite, cada passo pelo
mesmo processamento de um evento de verdade (os avisos ao contratante
contam a história inteira: pago, depois estornado); o segundo estorno
parcial perdido entra pelo acumulado. Sem caminho permitido, nada é
forçado e um humano é chamado em `erros`. A reentrega, pela Asaas, de um
evento que FALHOU reabre a linha com as tentativas zeradas e a processa
na hora — é o gesto de quem reenviou pelo painel dela; o reenvio pelo
nosso painel também zera as tentativas; e nenhuma linha em recuo é
reivindicada antes da hora (a passada seguinte do worker não queima a
tentativa). *Violada:* um `PAYMENT_CONFIRMED` que esgotasse as oito
tentativas deixava a cobrança `pendente` para sempre, com o dinheiro na
conta; um estorno de boleto cujo evento não veio ficava
`estorno_solicitado` para sempre. *Quem vê:* o comprador, o contratante
e o dono, sem sintoma nenhum. JULES-004, SEC-023, SEC-024.

**RN-58 · O acerto de uma troca nunca fica órfão, e nunca é cobrado duas
vezes.** A aprovação reivindica a intenção, cobra o acerto com a
referência `troca:<id da intenção>` e grava o `charge_id`. Se o processo
morre entre cobrar e gravar, ou a cobrança fica ambígua (timeout, 5xx),
a intenção fica em processamento e o arrendamento da assinatura FICA com
ela: o sweeper, depois de 3 minutos, procura a cobrança na Asaas pela
referência — achou uma, vincula e segue a classificação de sempre; achou
duas, chama um humano; não achou nada depois de 15 minutos, está provado
que nada foi cobrado e o link fecha (`STALE`). O `PAYMENT_CONFIRMED` do
acerto acha a intenção pela mesma referência, dita pela Asaas. Uma
recusa LIMPA da Asaas (4xx com corpo) fecha o link na hora. No máximo UMA
intenção por assinatura com dinheiro em trânsito (índice da migration
0019): a aprovação de outra vira `STALE`, e `POST /trocar-plano` responde
`409 troca_em_andamento`. Nenhum destes caminhos cobra de novo.
*Violada:* um deploy no meio da aprovação deixava a intenção em
processamento para sempre e o evento do acerto era descartado — o
assinante pagava e o plano não mudava; e um acerto ambíguo devolvia o
arrendamento, abrindo a porta para um segundo acerto. *Quem vê:* o
assinante, cobrado sem receber. SEC-009, SEC-010.

**RN-59 · Uma assinatura viva por plano e documento.** Sem o token de
renovação, `POST /assinatura` recusa (`409 assinatura_ja_existe`) quando
o comprador já tem uma assinatura `ativa` ou `pausada` daquele plano; a
troca de cartão tem porta própria, a renovação. *Violada:* reabrir o
link do plano e pagar abria uma segunda assinatura no mesmo cartão, e
cancelar desfazia só a mais recente. *Quem vê:* o assinante, cobrado em
dobro todo ciclo. SEC-012.

**RN-60 · A assinatura nasce inteira, e o que não nasce é visto.** O id
da assinatura na Asaas é gravado na cobrança já no primeiro evento de
pagamento, qualquer que seja o status; a assinatura NASCE (linha em
`assinaturas`, evento `criada`) com o primeiro dinheiro, decidido pela
ausência da linha — nunca por um vínculo já gravado. Toda escrita dessa
amarração relança o erro, e a inbox refaz; refazer não cancela de novo a
assinatura antiga de uma renovação. Primeiro ciclo recusado ou vencido
chama um humano (a assinatura segue viva na Asaas); pagamento de
assinatura sem cobrança nossa apontando para ela vira `erros`. O
`CHECKOUT_PAID` não vincula pagamento nenhum (o real não traz; um id
tirado do corpo só viria de um evento forjado). Depois que a Asaas
cancelou, pausou ou retomou, falha do registro local ou do aviso vira
`erros`, nunca um erro para quem chamou (repetir repetiria na Asaas), e
o arrendamento da assinatura volta também no sucesso. *Violada:* uma
falha de banco na primeira confirmação deixava a assinatura cobrando na
Asaas e 404 aqui; o ciclo seguinte a um primeiro ciclo recusado era
descartado com uma linha de log; e pausar travava cancelar por 5
minutos. *Quem vê:* o assinante e o contratante. SEC-011, SEC-013,
SEC-014, SEC-029.

**RN-61 · A área administrativa só responde a quem passou pelo Access —
na origem, não só na página.** Toda rota de `/api/admin`, inclusive a
de login, exige o JWT do Cloudflare Access do aplicativo do painel
(assinatura da equipe, `aud` do painel, `type: app`, dentro da
validade); sem ele, `401` antes da senha, pelo domínio da API ou pela
origem da Northflank. O painel chega à API por uma função do Pages no
próprio domínio, atrás do Access, que repassa só o JWT, o token de
sessão e o `content-type`. A senha continua sendo a segunda camada.
Não há desligamento; chaves do Access ilegíveis dão `503`. Tentativa
sem o Access não gasta o teto de login do operador. *Violada:* a API
do admin respondia a qualquer um pela origem, e o login inteiro ficava
ao alcance de quem soubesse o endereço; e as prévias do Pages serviam
`/admin` sem Access nenhum. *Quem vê:* o operador. SEC-015, NEW-01.

**RN-62 · A janela de pagamento de uma assinatura só volta para quem a
abriu.** A reserva da assinatura é pelo plano + CPF/CNPJ, e a sessão
pendente só é reaproveitada quando o e-mail e o telefone de quem pede são
os mesmos de quem a abriu (sem diferença de maiúsculas, espaço ou `+55`).
Diferentes, a antiga é encerrada na Asaas e nasce outra com os dados de
quem pediu; a sessão já concluída nunca é substituída, e o id dela só volta
para o mesmo pagador. *Violada:* com o CPF de alguém — que não é segredo —
e o link público do plano, recebia-se a janela de pagamento dela,
preenchida pela Asaas com nome, e-mail, telefone e endereço. *Quem vê:* o
assinante. NEW-02.

**RN-63 · Compra parcelada no cartão não se estorna pela API.** O estorno
pede à Asaas o estado da cobrança antes; se ela é parte de um parcelamento,
a resposta é `409 estorno_de_parcelamento` e nada é chamado — o estorno sai
pelo painel da Asaas, e o resultado chega pelo webhook. Sem conseguir
conferir, `502` e nada estornado. *Violada:* o `chargeId` da compra
parcelada é a primeira parcela; estorná-lo pelo endpoint de cobrança
arriscava devolver uma parcela e registrar o total como estornado. *Quem
vê:* o comprador e o contratante. SEC-018 (a medição no sandbox do estorno
de parcelamento fica em `docs/pendencias.md`).

**RN-64 · Escrita de estado confere o estado que leu.** A conciliação do
contratante só grava `confirmado` sobre o status que ela leu; a reserva só
é apagada enquanto é reserva (pendente, sem pagamento e sem sessão); e a
autorização do Pix Automático só ativa o que está pendente e só encerra o
que está pendente ou confirmado. Quem perde a corrida não escreve. *Violada:*
um estorno gravado pelo webhook no meio da conciliação voltava a
`confirmado`; uma reserva que ganhou pagamento podia ser apagada; e a
reentrega da autorização repetia o aviso ao contratante. *Quem vê:* o
contratante e o operador. SEC-020, SEC-022, SEC-025.

**RN-65 · Worker parado derruba a saúde.** `/api/saude` responde `503` quando
um worker (inbox, outbox, reconciliadores, cancelador de irmãs, varredura
da troca) fica sem uma passada bem-sucedida por mais de três intervalos
dele e mais dois minutos, e lista quais em `workersAtrasados`. *Violada:* o
HTTP era `200` com o worker parado — e o monitor de uptime lê o código, não
o corpo. *Quem vê:* o operador. SEC-031.

**RN-66 · Nenhuma rota derruba o processo.** Todo handler do Express — do
`app` e de todo roteador (`src/utils/rotaSegura.js`) — manda o que lançar,
síncrono ou assíncrono, para o tratador de erro do fim da pilha: `500`
genérico e linha em `erros`. A guarda do Access recusa (`401`) qualquer
token que ela não consiga julgar. *Violada:* um JWT com `alg` objeto, sem
login e antes de todo limitador, lançava dentro de um handler `async`, e o
tratador de `unhandledRejection` encerrava a única instância — checkout,
webhook e workers juntos. *Quem vê:* todos. C1-01.

**RN-67 · O webhook responde à Asaas no teto, não quando ela responde.** O
processamento continua inline (a ordem de `SEQUENTIALLY`), mas passado
`TETO_DE_RESPOSTA_DO_WEBHOOK_MS` (8 s) o `200` sai e o processamento
termina em segundo plano, com a linha já na inbox. As passadas da inbox
(120 s) e da outbox (60 s) têm orçamento: o que sobra fica para o próximo
tique, na mesma ordem. *Violada:* com a Asaas lenta, a conferência de
SEC-007 segurava o `200` por dezenas de segundos — 15 seguidas pausam a
fila da conta inteira; e um contratante pendurado deixava o `/api/saude`
em `503` por culpa dele. *Quem vê:* todos os contratantes. C1-06, C1-07.

**RN-68 · Ciclo de assinatura é identificado pela assinatura.** Todo ciclo
leva a referência da 1ª reserva; a conferência de vínculo de um ciclo já
amarrado compara `payment.subscription` com a linha, não a referência. E a
renovação refeita depois de a nova já estar gravada ainda encerra a antiga
(idempotente). *Violada:* do 2º ciclo em diante, todo evento lançava
"vínculo inconsistente" para sempre — o ciclo recusado e depois pago ficava
`vencido`; e o crash entre gravar a nova e cancelar a antiga deixava as
duas cobrando. *Quem vê:* o assinante e o contratante. C1-02, C1-03.

**RN-69 · A tela do comprador não confirma o que o webhook não confirmaria.**
A conciliação pela consulta de status tem o mesmo binding de valor do
webhook: pago na Asaas com valor diferente do cobrado não vira
`confirmado` sozinho. *Violada:* o webhook recusava, e a próxima consulta
da tela confirmava por cima. *Quem vê:* o comprador e o contratante. C1-10.

**RN-41 · A linha local nasce ANTES da chamada à Asaas, e a Asaas leva
a nossa referência.** Pix, Boleto e as duas pop-ups reservam a linha
(índice único: pedido+método, ou plano+documento+método) e só então
criam na Asaas, com `externalReference = reserva-<id>`. Quem esbarra
na reserva reaproveita o que ela tem. Falha ambígua da Asaas NÃO libera
a reserva: o reconciliador (5 min) pergunta à Asaas pela referência,
completa a linha quando existe cobrança lá e reenfileira os eventos já
consumidos; libera só depois de 65 min sem nada. *Violada:* dez cliques
simultâneos abriam dez sessões pagáveis. *Quem vê:* o comprador, com
dez cobranças no app. C-04/H-06.

**RN-42 · O preço cobrado é o preço mostrado.** `GET /pedido` e
`GET /plano` gravam a cotação (retrato financeiro + totais por método e
parcela, 30 min); o `POST` que cobra exige o id, reconsulta o
contratante, compara em centavos e cobra o retrato — divergência ou
cotação vencida é `409 cotacao_alterada`/`cotacao_ausente` com a
cotação nova, e a tela redesenha tudo (subtotal, parcelas, total) e
pede reconfirmação; sem total utilizável, os botões travam. O valor da
parcela vem da cotação, nunca é dividido na tela. *Violada:* o
contratante mudava o preço entre a tela e o clique, e o pagador pagava
o que não viu. *Quem vê:* o pagador. C-02, `API.md` §9.3.

**RN-43 · O aviso ao contratante é durável e tem identidade.** Todo
fato vira UMA linha em `outbox_notificacoes`, com chave do fato
(`pedido|charge|status`, `assinatura|charge|evento|status`, e o
acumulado em centavos nos parciais); a linha carrega o `eventoId` que
o contratante recebe e pelo qual deduplica; um worker entrega com recuo
finito (1 min … 24 h) e depois marca `abandonada`, que o operador
reenvia com o mesmo id. Mesmo fato por outro caminho (estorno pedido
em `/estornar`, reentrega da Asaas, reprocessamento) cai na mesma linha.
Um fato que se REPETE de verdade (baixa desfeita e refeita) ganha linha
nova. *Violada:* reiniciar o processo entre duas tentativas perdia o
aviso; e o contratante creditava um ciclo duas vezes por não ter como
distinguir reenvio de fato novo. *Quem vê:* o contratante. H-01/H-02,
provado por `tests/outbox-sobrevive-a-reinicio.js` com dois processos.

**RN-44 · Um pagador é um cliente na Asaas, e a reivindicação vem
antes da chamada.** `clientes_asaas` (documento em hash) é reivindicada
antes de `POST /v3/customers`; quem perde espera o id do vencedor, e
uma reivindicação de processo morto (30 s) é assumida. *Violada:* dez
requisições simultâneas criavam dez clientes na Asaas. *Quem vê:* o
operador, com cadastro duplicado no painel da Asaas. H-05.

**RN-45 · Estorno parcial existe, e é aritmética de centavos.**
`POST /estornar` aceita `valor`; a cobrança fica
`estornado_parcialmente` com `valor_estornado` acumulado e pode ser
estornada de novo até completar; estorno parcial feito no painel da
Asaas chega como tal, com o acumulado, e um segundo parcial é fato
novo. Boleto continua tudo-ou-nada. A assinatura nasce e a antiga
(renovação) é cancelada SÓ no `confirmado` da primeira cobrança —
nunca num `em_analise` ou `recusado` que chegue antes. *Violada:* o
contratante revogava o pedido inteiro por uma devolução de parte; uma
renovação com cartão recusado cancelava a assinatura que ainda pagava.
*Quem vê:* o pagador. H-04, `CONSTRAINTS.md` §1.7.

**RN-46 · A chave de um contratante aparece inteira uma vez.** Na
resposta de criação e na de rotação — quem acabou de gerá-la. Em toda
listagem e edição do painel vai `api_key_final` (4 últimos), nunca
`api_key`; o mesmo para subcontas. *Violada:* abrir o painel devolvia
todas as chaves de todos os contratantes — um XSS no admin ou um token
de sessão vazado levava tudo de uma vez. *Quem vê:* todos os
contratantes, sem saber. H-08, `tests/segredo-nao-sai-do-admin.js`.

**RN-47 · Sessão concluída não é pagamento.** `CHECKOUT_PAID` diz que o
pagador terminou a pop-up — cartão digitado, assinatura criada —, não
que o dinheiro entrou. Ele só carimba `sessao_concluida_em`; a linha
segue `pendente` até `PAYMENT_CONFIRMED`/`RECEIVED`. A tela recebe
`PROCESSANDO` e diz **"Pagamento em processamento…"**, fecha a pop-up e
continua acompanhando; só `confirmado` vira "Pagamento Aprovado ✓" /
"Assinatura Ativa ✓". Recusa (`PAGAMENTO_RECUSADO`) volta o botão. Quem
volta à página e clica de novo depois de concluir recebe 409
`pagamento_em_processamento` e a tela acompanha a MESMA sessão — nunca
abre outra, e a reserva dessa sessão nunca expira sozinha.
*Violada:* foi o primeiro pagamento real de assinatura, 25/09/2026 — a
tela mostrou "Assinatura Ativa ✓" com o 1º ciclo `PENDING` e o cartão
sem débito, a linha ficou `confirmado`, e a métrica contaria R$ 10,00
que não entraram; se o cartão fosse recusado no vencimento, a linha
ficaria `confirmado` para sempre. *Quem vê:* o pagador (sucesso falso),
o dono (métrica falsa). A tela de status pública (`status.html`) também
recebe `emProcessamento` e diz "Pagamento em processamento — estamos
aguardando a confirmação da operadora", nunca "aguardando pagamento"; e
a página que a pop-up abre ao terminar não afirma resultado nenhum (ela
é a mesma no sucesso, no cancelamento e na expiração).
`tests/sessao-concluida-nao-e-pagamento.js` e o autoteste do
`webhookController` (seção 16b, payloads reais).

**RN-48 · Pix que existe se recupera; nunca é beco sem saída.** Se o
Pix foi criado e só o QR falhou, a linha ganha o `chargeId` e o pagador
na hora, e a resposta é 503 `qr_indisponivel` — o botão vira "Tentar de
novo", e o próximo clique busca o QR do MESMO Pix. Se a criação ficou
ambígua (timeout), o clique seguinte confere na Asaas pela referência da
reserva e, achando, amarra e mostra o QR; não achando, 409
`cobranca_em_confirmacao`. Nunca cria um segundo Pix. *Violada:* no
primeiro Pix real (25/09/2026) a conta de produção não tinha chave Pix;
o pagamento existia, o QR não, e o segundo clique respondia "Já existe
uma cobrança sendo criada" até o reconciliador passar, 5 minutos depois.
*Quem vê:* o pagador, preso. Autoteste do `checkoutController` (8b, 8c).

**RN-49 · Toda data que vai para a Asaas é de Brasília.** Vencimento de
Pix, boleto, acerto de troca, 1º ciclo da assinatura e início do Pix
Automático saem de `src/utils/diaCivil.js`, nunca do relógio do
processo, que roda em UTC. *Violada:* entre 21h e meia-noite o "hoje"
do processo já é amanhã — no primeiro pagamento real de assinatura
(22:26 de Brasília) o 1º ciclo foi agendado para o dia seguinte e o
cartão não foi cobrado no ato. *Quem vê:* o pagador (não é cobrado
quando espera) e o contratante (acesso liberado sem pagamento, se
confiar na tela). `tests/data-para-asaas-e-de-brasilia.js` varre `src/`.

**RN-50 · Telefone é DDD + número, sem o código do país.** Só dígitos; se
sobrarem 12 ou 13 começando por `55`, o `55` é o país e sai.
`16987654321`, `(16) 98765-4321`, `+55 16 98765-4321` e
`55 16 98765-4321` são o MESMO telefone. Número nacional com DDD 55 (RS)
tem 10 ou 11 dígitos e fica como está. A regra vive no servidor
(`normalizarTelefone`, `src/utils/validadores.js`) e na tela
(`public/js/utils/masks.js`), e as duas são conferidas contra o mesmo
corpus; o campo aceita até 20 caracteres, para o autopreenchimento não
ser cortado antes da máscara. *Violada:* no primeiro teste real
(25/09/2026) o navegador preencheu `+55 16 …`, o campo cortava em 15 e a
máscara pegava os 11 primeiros dígitos — `55` virava DDD. *Quem vê:* o
pagador, com telefone errado na cobrança; e a Asaas, que recusa telefone
inválido. `tests/telefone-com-codigo-do-pais.js`.

---

## 6. Textos que o sistema diz

**Rótulos de botão do comprador:** "Gerar QR Code Pix", "Gerar Boleto",
"Continuar" (cartão), "Assinar Agora", "Pagar com Pix" (Pix Automático),
"Copiar", "Abrir boleto".

**Aceite, no checkout:** "Li e concordo com os Termos de Uso e a Política
de Privacidade."

**Rodapé do comprador:** "Quer cancelar a compra ou desistir dela? Fale
com a loja onde comprou — é ela que autoriza o estorno, que volta pelo
mesmo meio de pagamento." · "Seus dados pessoais (acesso, correção,
exclusão): juridico@sancocore.com.br" · "Problema nesta página:
suporte@sancocore.com.br".

**Erros, que são os que mais importam porque aparecem no pior momento:**

| situação | texto |
|---|---|
| contratante não existe | "Contratante não encontrado." |
| pedido não existe | "Pedido não encontrado." |
| API do contratante fora do ar | "Não foi possível carregar os dados do pedido, tente novamente." |
| total não utilizável | "Não foi possível calcular o valor desta compra. Recarregue a página ou peça um link novo ao vendedor." |
| plano sem valor | "Este plano está sem valor definido. Peça um link novo ao vendedor." |
| campo obrigatório faltando | "Nome, e-mail e CPF/CNPJ são obrigatórios." |
| documento inválido | "CPF/CNPJ inválido." |
| e-mail inválido | "E-mail inválido." |
| nome fora do teto | "Nome inválido." |
| pedido já encerrado | "Este pedido já está com status \"pago\"." |
| valor fora da faixa | "Valor do pedido inválido." |
| limite de requisições | "Muitas tentativas em pouco tempo. Aguarde um minuto." |
| rota inexistente | "Rota não encontrada." |
| erro nosso | "Erro interno. Tente novamente em instantes." |
| pop-up concluída, dinheiro ainda não confirmado (RN-47) | botão "Pagamento em processamento…" · "Recebemos seu pagamento e estamos aguardando a confirmação da operadora. Não é preciso pagar de novo." |
| clicou de novo depois de concluir a pop-up | "Você já concluiu este pagamento e ele está em processamento. Aguarde a confirmação — não é preciso pagar de novo." |
| Pix criado, QR indisponível (RN-48) | "Seu Pix foi criado, mas o QR Code não pôde ser gerado agora. Tente de novo em instantes — é o mesmo Pix, você não será cobrado duas vezes." · botão "Tentar de novo" |
| tentativa anterior ainda sendo conferida | "Estamos confirmando uma tentativa anterior deste pagamento. Tente de novo em instantes — nada será cobrado duas vezes." |

**Vazios do painel:** "Nenhum contratante cadastrado" / "Cadastre o
primeiro projeto que vai usar o checkout." · "Nenhuma subconta criada" ·
"Nenhuma cobrança no período" · "Nada arquivado" · "Nenhum webhook
recebido ainda".

**Confirmações destrutivas do painel**, que explicam o efeito em vez de
perguntar "tem certeza?": a de arquivar diz que o cadastro e o histórico
continuam guardados e que o link antigo para de cobrar; a de trocar
chave diz que a atual para de valer na hora e que a integração fica
parada até o outro lado colar a nova.

---

## 7. Quando dá errado

| falha | o que o sistema faz | o que a pessoa vê |
|---|---|---|
| API do contratante fora do ar | 504, nenhuma cobrança criada | tela indisponível, `R$ —` |
| API do contratante devolve pedido sem valor cobrável | rota devolve `taxa: null` | tela indisponível, sem botão — nunca um total que é só a taxa |
| API do contratante devolve plano sem valor | o front recusa resolver | aviso de pedir link novo ao vendedor |
| Asaas fora do ar | erro genérico, nada gravado como pago | "Erro interno. Tente novamente em instantes." |
| comprador dá duplo clique em gerar cobrança | a segunda chamada reaproveita a primeira (RN-04) | o mesmo Pix, sem cobrança duplicada |
| comprador volta no navegador e clica de novo | idem — o pedido já tem cobrança pagável | o mesmo código |
| pagamento cai depois do prazo | a Asaas manda o evento; o status vira `vencido` ou `confirmado` conforme o evento real | a página de status, que atualiza sozinha |
| webhook com token errado | 401, contado em `webhook_rejeicoes` por hora, sem gravar linha por tentativa | o operador, na aba Webhook |
| webhook de evento não mapeado | gravado como `nao_mapeado`, resposta 200 para a Asaas não pausar a fila | o operador, na aba Webhook |
| banco fora do ar | erro genérico; cobrança na Asaas pode existir sem linha local — a conciliação (`API.md` 5.2) é a rede | o comprador, erro genérico |
| duas cobranças simultâneas do mesmo pedido | a segunda reaproveita a primeira | nada — é o comportamento certo |
| chave da Asaas expirando ou apagada | evento `ACCESS_TOKEN_*` vira alerta em `/api/saude` | o operador, se olhar a rota |
| instância sem memória | a fila de derivação impede duas derivações scrypt simultâneas (§2, gargalo 0) | o operador, com login mais lento |
| **qualquer 5xx, de qualquer rota** | vira linha em `erros`, agrupada por onde acontece; repetição soma em vez de repetir | o operador, na aba **Erros** (RN-27) |

---

## 8. Direitos e obrigações que viram tela

Cada direito é **tela ou fluxo das seções 2 a 7** — esta seção é o mapa,
não o lugar onde eles moram.

Dois fatos do desenho mandam nesta lista: **o comprador não tem conta
aqui**, e **quem vende é o lojista** (`public/termos.html` §1.4). O San
Checkout é infraestrutura de pagamento.

| direito ou obrigação | onde está | seção |
|---|---|---|
| Confirmação da contratação | resumo com o total antes de pagar, e página de status com link permanente entregue junto do Pix e do boleto | 2.1 passos 3 e 6; 3; 4.1; 4.2 |
| Termos e política antes de pagar | caixa de aceite no checkout, com os dois links | 2.1 passo 5; 6 |
| Arrependimento e cancelamento (CDC art. 49) | rodapé da página de status: resolve-se **com a loja**, que autoriza o estorno; a execução é nossa, por `POST /checkout/estornar` com a chave dela | 2.6 passo 2; 2.7 passo 5; 6 |
| Canal do titular / Encarregado (LGPD art. 18) | rodapé do checkout e da página de status, `juridico@sancocore.com.br` | 2.6 passo 3; 3; 6 |
| Acesso, correção, portabilidade e eliminação | pelo mesmo canal, com a retenção de 5 anos declarada em `docs/inventario-de-dados.md` §6 | 2.6 passo 3 |
| Atendimento de problema técnico | `suporte@sancocore.com.br`, no rodapé | 2.6 passo 4 |

**Os quatro que não viram tela, e por quê:**

**Excluir conta — não existe conta.** O comprador não tem cadastro nem
login. O que existe é o dado da cobrança, sob retenção de 5 anos por
obrigação fiscal: eliminar antes disso conflita com a lei, e é por isso
que o pedido passa por um canal que sabe separar os dois casos.

**Exportar os próprios dados por botão — deliberadamente não.** A página
de status abre com o par contratante+pedido, que identifica uma cobrança
e **não autentica uma pessoa**. Botão de exportar ali entregaria dado
pessoal a quem tiver o id do pedido.

**Revogar consentimento — não se aplica.** O tratamento não se apoia em
consentimento, e sim em execução de contrato e obrigação legal
(`public/privacidade.html` §9). Botão de revogar prometeria o que não
existe.

**Botão de arrependimento com estorno no mesmo fluxo — não, e é
arquitetura.** O checkout recebe pagamento; a decisão de devolver é de
quem vendeu, e chega aqui como autorização autenticada pela
`X-Checkout-Key` do lojista. Um botão nesta tela precisaria decidir,
sozinho, se a devolução é devida — que é exatamente o que este sistema
não sabe. A obrigação que sobra para nós é não atrapalhar, executar o
estorno autorizado, e **dizer na tela onde se resolve** — o que a 2.6
faz.

**O que falta, declarado:** ticket de atendimento com auto-resposta e
protocolo. Hoje o canal é e-mail, sem número e sem prazo contado.
Pendência em `docs/pendencias.md`.

---

## 9. A métrica de sucesso e os eventos que a alimentam

**Métrica principal:** cobranças **confirmadas** por contratante, por
dia — com o valor pago que elas somam. Decidida pelo dono em 13/09/2026
e registrada no spec.

É precursora da receita e não a receita: mede o motor entregando o que
promete (cobrança que vira dinheiro), sem depender de fechamento
contábil.

**Ela responde "quantos ontem?" desde 16/09/2026**, e antes disso não
respondia. `GET /api/admin/metricas` contava as últimas N×24 h, sem
recorte por dia: às 10h da manhã, "últimas 24 h" mistura metade de hoje
com metade de ontem — parecido, e não a mesma coisa. Agora a janela é por
**dia civil de Brasília**, e a aba Métricas mostra "Ontem" e "Hoje" por
extenso, antes de qualquer gráfico.

Duas coisas tiveram de existir para isso, e as duas são o conteúdo da
correção:

- **`cobrancas.confirmado_em`** (migration 0008). Não havia coluna
  nenhuma dizendo quando a cobrança foi confirmada: `criado_em` diz
  quando foi *gerada*, e `atualizado_em` muda por qualquer motivo —
  inclusive reparo manual. Sem uma data própria, "confirmadas ontem" era
  inrespondível, e usar `atualizado_em` daria um número que parece certo
  e anda sozinho. Linha confirmada antes da migration fica com nulo, e
  a rota a devolve em `confirmadasSemData` em vez de jogá-la num dia
  qualquer — **nulo é informação, não falta**.
- **O dia civil decidido no servidor** (`src/utils/diaCivil.js`).
  Medido dentro do contêiner em 16/09: o processo de produção roda em
  **UTC**. Qualquer conta com data local do servidor erraria das 21h à
  meia-noite de Brasília, três horas por dia. O fuso nomeado funciona na
  imagem (ICU completo, também medido), e há um teste que fica vermelho
  se isso deixar de ser verdade — senão `Intl` cai para UTC em silêncio.

**As duas bases de dia, que respondem perguntas diferentes:**

| campo | base | pergunta |
|---|---|---|
| `confirmadasPorDia` | `confirmado_em` | **é a métrica** — quantas cobranças entraram naquele dia, independente de quando nasceram |
| `geradasPorDia` | `criado_em` | coorte — das cobranças nascidas naquele dia, quantas viraram dinheiro; avalia a tela e o link |

Uma cobrança gerada dia 15 e paga dia 16 conta em `geradasPorDia[15]` e
em `confirmadasPorDia[16]`. **Os dois números estarem diferentes é o
comportamento certo**, não inconsistência — e é o caso normal de
assinatura, cujo ciclo nasce num mês e confirma noutro.

Com `dias=1`, `ontem` volta como `foraDaJanela` em vez de zero: zero
afirmaria que não houve nenhuma, que é diferente de não ter olhado.

### Os eventos

Nove eventos, nomeados na convenção `categoria:objeto_acao` com verbo no
presente e propriedades `objeto_adjetivo`, **antes** da primeira linha de
instrumentação. Os críticos — ação central e pagamento confirmado — são
emitidos **no servidor**, nunca no navegador.

| evento | onde é emitido | propriedades | pergunta que responde |
|---|---|---|---|
| `checkout:pedido_resolve` | servidor, `pedidoController.obterPedido`, quando o pull devolve pedido com valor cobrável | `contratante_id`, `pedido_id`, `valor_base` | quantos links viraram tela utilizável? é o denominador honesto, sem instrumentar o navegador |
| `checkout:cobranca_cria` | servidor, `checkoutController` (Pix, boleto, cartão) | `contratante_id`, `cobranca_id`, `pedido_id`, `metodo_pagamento`, `valor_cobrado` | quantas cobranças geradas, por método e por contratante? |
| **`checkout:cobranca_confirma`** | servidor, `webhookController`, no mapa de `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` | `contratante_id`, `cobranca_id`, `metodo_pagamento`, `valor_cobrado`, `taxa_total` | **quantas confirmadas ontem, por contratante? — é a métrica** |
| `checkout:cobranca_falha` | servidor, `webhookController` (recusado ou vencido) | `contratante_id`, `cobranca_id`, `metodo_pagamento`, `motivo_falha` | qual método perde mais cobrança, e onde vale mexer na tela? |
| `checkout:cobranca_estorna` | servidor, `webhookController` (`PAYMENT_REFUNDED`) ou estorno autorizado pelo lojista | `contratante_id`, `cobranca_id`, `valor_estornado` | quanto do confirmado volta atrás? |
| `checkout:cobranca_contesta` | servidor, `webhookController` (chargeback) | `contratante_id`, `cobranca_id`, `valor_contestado` | qual contratante traz risco? |
| `assinatura:assinatura_cria` | servidor, no webhook da primeira cobrança paga | `contratante_id`, `plano_id`, `assinatura_ciclo` | quantas assinaturas novas por ciclo? |
| `assinatura:assinatura_cancela` | servidor, no cancelamento | `contratante_id`, `plano_id`, `motivo_cancelamento` | quanto tempo uma assinatura dura? |
| `webhook:entrada_rejeita` | servidor, na guarda de token do webhook | `rota_alvo`, `janela_hora` | alguém está tentando forjar webhook? |

**Uso interno filtrado, desde 17/09/2026:** o contratante de teste
(`testemaster`) produz cobrança confirmada de mentira, e o sandbox
inteiro também. As duas colunas que resolvem isso estavam desenhadas na
migration 0004 e nunca foram escritas; entraram na **0009**, e em
`cobrancas` — não em contratantes, como a 0004 previa, porque a marcação
é da cobrança: o contratante real pode ter uma linha de teste, e o
contratante de teste pode ser arquivado sem levar o histórico embora. A
regra inteira é a RN-33, e o que ela exclui aparece no painel em vez de
desaparecer.

**O que existe hoje, e o que falta.** Nenhum destes nove é gravado como
linha de evento: a métrica é **derivada de `cobrancas`**, por
`GET /api/admin/metricas?dias=N` → `porContratante[id].pagas`,
`.valorPago`, `.taxaPagamento`. Isso responde "quantos ontem?" com
número, que é o que a estação 6 exige — e responde **por dia civil de
Brasília** desde 16/09/2026, como o começo desta seção descreve. Este
parágrafo trazia a ressalva de que `dias=N` contava as últimas N×24 h:
era verdade até aquele dia, e ficou aqui depois de deixar de ser, com a
correção escrita quinze linhas acima. A tabela
`eventos(usuario_id, nome, propriedades, criado_em)` **não existe, e não
está em pendência nenhuma** — o que a estação 6 cobra é a pergunta
respondida com número, e ela é respondida sem a tabela. Os nomes acima
seguem sendo o contrato de quando alguma pergunta exigir linha por
evento; nesse dia a tabela entra como trabalho novo, não como dívida
antiga.

**Dois eventos que não existem de propósito:** `checkout:pagina_abre` e
`checkout:pedido_indisponivel_ve`. Ambos são do navegador, exigiriam
gravar linha por visita e trariam bot junto. Enquanto a pergunta
principal for "quantas cobranças confirmadas ontem, e de quem", a
resposta sai de `cobrancas` sem instrumentação nova.

---

## 10. O que fica fora desta versão

A lista é do `CONSTRAINTS.md` §1 (vetado e fora de escopo) e do
`docs/proximas-versoes.md` (adiado com gatilho) — sem repetição aqui.

---

## 11. Acessibilidade — o que foi verificado, e como

Obrigação legal, não opcional: LBI (Lei 13.146/2015, art. 63) e Decreto
9.405/2018 valem **inclusive para ME, EPP e MEI**. Padrão exigível:
**WCAG 2.2 nível AA**. Verificado em 17/09/2026.

**Como se reverifica:** `npm run acessibilidade`. Sobe as telas num
Chromium de verdade (390×844, largura de celular) e roda o axe-core
contra as regras WCAG 2.2 AA. Falha com código 1 se achar violação.

Navegador de verdade e não jsdom porque **contraste** é um dos itens que
a lei exige nominalmente, e contraste só se calcula com layout e cor
computada — em jsdom o axe simplesmente não roda essa checagem, e um
verificador que pula o item exigido devolve "sem violações" sem ter
olhado.

### O que foi corrigido para passar

| achado | onde | correção |
|---|---|---|
| `--text-muted` dava **2,54:1** sobre branco (mínimo 4,5:1) | 4 telas | escurecido para `#616A7D` — pior caso **4,80:1**, medido contra todas as superfícies, inclusive a mais apertada (`--bg-surface`) |
| link do 404 dava **3,75:1** | `404.html` | `#806313` — **5,27:1** |
| as duas páginas legais carregavam **cópia inline da paleta** | `termos.html`, `privacidade.html` | passam a carregar `theme-engine.css`. Era a causa raiz: o token foi corrigido no arquivo central e as cópias não viram |
| **19 de 20 SVGs** sem `aria-hidden` | checkout e painel | todos são ícones decorativos ao lado de texto, e agora estão escondidos do leitor de tela. O axe não sinaliza isto — foi revisão humana |

Consequência aceita do contraste: "muted" ficou menos muted, e a
hierarquia visual contra `--text-secondary` comprimiu. É o preço de o
cinza carregar informação em vez de decoração — se tem texto, tem de ser
legível. Hierarquia se recupera com tamanho e peso, não com cor mais
clara.

### O que o verificador cobre

Oito telas, no estado em que o comprador as vê: checkout (pedido avulso
**e** assinatura, que carregam por endpoints diferentes), status, termos,
privacidade, 404, fechar pop-up, e o painel do operador. Mais os três
acordeões de método abertos, e uma passada **só com Tab**, sem mouse, que
confere foco visível e nome acessível em cada uma das 56 paradas.

**Ele exige provar que auditou a tela certa.** A primeira versão
reportou "Checkout — 0 violações" auditando a tela de *"Acesso não
autorizado"*: sem os parâmetros na URL, a página se substitui por ela.
Zero violação numa tela que não é a tela parece evidência e não é. Agora
o pedido e o plano são dublados com o formato real da API, e a tela tem
de mostrar um número mínimo de elementos interativos visíveis, ou o
verificador reprova. Mesma regra para o teclado: menos de 10 paradas
reprova, em vez de exibir dois tiques verdes sobre nada medido.

### O que ele NÃO cobre, e fica com revisão humana

**Ordem de foco que faça sentido** — ele confere que cada parada tem
indicador e nome, não que a sequência siga a leitura da tela. **Qualidade
do texto alternativo** — confere que existe, não que descreve a imagem
certa (hoje não há imagem de conteúdo; todo SVG é decorativo).
**"Nada informado só por cor"** — conferido à mão em 17/09: os selos de
status trazem a palavra ("Não encontrado", "Pago"), não só a cor.

Estados que dependem de resposta real da Asaas — QR gerado, boleto
emitido, erro devolvido pelo servidor — não entram no verificador: eles
exigem cobrança viva. Ficam para a rodada ao vivo no sandbox.

---

## Como saber que está pronto

As quatro perguntas do modelo, e as quatro precisam ser "sim":

1. **Consigo construir cada tela lendo só isto, sem inventar
   comportamento?** Sim — sete telas com URL, conteúdo, ações e destino
   (seção 3), e os seis estados de cada uma (seção 4), com "não se
   aplica" escrito onde não se aplica.
2. **Cada papel tem jornada completa, e cada tela pertence a alguma
   jornada?** Sim — comprador (2.1 a 2.6), contratante sem tela por
   desenho (2.7), operador (2.8 a 2.12). As sete telas aparecem em
   jornada.
3. **Cada regra de negócio tem consequência escrita?** Sim — RN-01 a
   RN-13, cada uma com o que acontece na violação e quem vê.
4. **Cada fluxo tem o caminho de quando dá errado, e os eventos da
   métrica estão nomeados?** Sim — seção 7 por fluxo, mais os estados de
   erro das 4.1 a 4.3; e os nove eventos da seção 9, na convenção, com
   onde são emitidos, propriedades e a pergunta que respondem.
