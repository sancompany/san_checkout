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
| Vazio | texto próprio por seção: "Nenhum contratante cadastrado" (com "Cadastre o primeiro projeto que vai usar o checkout."), "Nenhuma subconta criada", "Nenhuma cobrança no período", "Nada arquivado", "Nenhum webhook recebido ainda" |
| Erro | mensagem do backend em toast, sem detalhe interno |
| **Sem permissão** | Cloudflare Access barra antes da página; sem token válido, `401`; **backend sem as variáveis de admin devolve `503`, não `401`** — "admin desativado" é diferente de "senha errada"; mais de 5 tentativas de login por minuto, `429` |
| Lista longa demais | a aba Webhook pede os **100** eventos mais recentes e o backend limita a **200** (padrão 50); as demais listas são pequenas por natureza — um operador, poucos contratantes |

Sem sessão guardada em cookie: o token fica no `sessionStorage` da aba e
vai em todo request (limite declarado em `CONSTRAINTS.md` §2.6).

### 4.4 Termos, Privacidade, 404 e fechar pop-up

Páginas estáticas. **Carregando, vazio, erro, sem permissão e lista
longa não se aplicam** — não consultam nada e não têm estado. A 404 é
servida com status HTTP 404, não 200.

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

**RN-34 · O valor de uma assinatura pode mudar na Asaas, e hoje nada
nos conta.** A Asaas **aceita** alterar `value` e `cycle` de uma
assinatura ativa — aumentar, diminuir e trocar o ciclo —, medido no
sandbox em 17/09/2026 em assinatura de cartão e de boleto. O checkout
**não expõe rota** para isso (as quatro são criar, cancelar, pausar e
retomar), e **não recebe aviso quando acontece**: nenhum evento chegou
ao receptor em toda a bateria de alterações, porque `SUBSCRIPTION_*`
não está entre os 53 eventos configurados e `PAYMENT_UPDATED` está
desmarcado de propósito (`CONSTRAINTS.md` §2.2). *Violada:* mudado o
preço no painel da Asaas, ela passa a cobrar o valor novo e
`assinaturas.valor` aqui continua o antigo — a conciliação
(`API.md` §5.3) reconfere `status`, `ciclo` e `proximaCobranca` contra a
Asaas, **e não reconfere `valor`**. O contratante que confia nesse campo
mostra ao assinante um preço que não é o cobrado, para sempre e sem
sintoma. É a MESMA família do bug do `ciclo` de 15/09 (dado local que
divergiu da fonte e ninguém reparava) por outra porta: a correção de
16/09 fechou `ciclo` e deixou `valor` aberto. *Quem vê:* ninguém, até
alguém comparar a fatura com a tela. Por isso o `API.md` §5.3 passou a
dizer, na cara do integrador, que `valor` não é preço vigente — o que é
verdade é `ultimaCobranca.valorCobrado`, que é histórico de cobrança
real. **Declarado, não corrigido às cegas:** reconciliar `valor` é
mudança no caminho do dinheiro e depende de decisão do dono (é a Asaas
que passa a mandar no número, inclusive quando a alteração de lá foi um
erro humano) — `docs/pendencias.md`.

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
