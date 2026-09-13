# Definição funcional — San Checkout (SAN & CO. Pay Engine)

O que o sistema faz, tela por tela, em detalhe suficiente para construir
sem inventar comportamento.

**Registro retroativo**, escrito em 12/09/2026 a partir do que existe em
produção — não é desejo, é descrição. Onde o documento e o código
divergirem, o código é a verdade e este arquivo se ajusta.

**Este é o único documento de definição que muda durante o projeto.**
Comportamento ajustado é comportamento reescrito aqui, na mesma tarefa
que o ajustou. O `docs/specs/` registra por que o projeto existe e não se
atualiza; o `CONSTRAINTS.md` registra o que ele não faz; este diz o que
ele faz.

---

## 1. Público-alvo

Três papéis, e só o primeiro vê o produto:

**O comprador** — pessoa física ou jurídica pagando algo de um projeto do
ecossistema. Não conhece o San Checkout, não tem conta, não volta. Chega
por um link e sai quando pagou. Muitas vezes **não tem cartão de
crédito** — é o motivo de Pix e boleto serem cidadãos de primeira classe,
não alternativas.

**O contratante** — o projeto que vende (Trimundi9, Vitrina ADS, os que
vierem). Não usa tela nenhuma: integra por API, expõe `GET /pedido/{id}`
e recebe webhook. Quer o dinheiro na conta e o aviso de que entrou.

**O operador** — uma pessoa, o dono. Cadastra contratante, cria subconta
na Asaas, olha métrica e log de webhook. É o único usuário do painel
administrativo, e isso é premissa de desenho, não acaso: não há papéis,
não há permissões, não há multiusuário.

---

## 2. Jornadas

### 2.1 Comprador paga uma compra avulsa (Pix)

1. Recebe do contratante um link `checkout.sancocore.com.br/index.html?c=<contratante>&pedido=<id>`.
2. A tela carrega, busca o pedido na API do contratante e mostra o resumo
   com o total.
3. Escolhe Pix, preenche nome, e-mail, CPF/CNPJ e telefone.
4. Clica em **Gerar QR Code Pix**; recebe QR e código copia-e-cola.
5. Paga no banco. A página de status atualiza sozinha quando confirma.

### 2.2 Comprador paga com boleto

Igual até o passo 3. Clica em **Gerar Boleto**, recebe linha digitável e
link do PDF. Compensação leva de um a três dias úteis — a página de
status é o canal.

### 2.3 Comprador paga com cartão

Igual até o passo 3, mais o endereço completo (a Asaas exige para
cartão). Clica em **Continuar**, e o pagamento acontece numa **pop-up
hospedada pela Asaas** — o cartão nunca passa por nós, que é o que
mantém o projeto fora do escopo PCI-DSS (`CONSTRAINTS.md` §1.1).

### 2.4 Comprador assina uma recorrência

Link com `?assinatura=<planoId>` em vez de `?pedido=`. O resumo mostra o
valor do ciclo. Assinatura por cartão vai pela pop-up da Asaas;
assinatura por Pix Automático existe no código mas **está desligada**
(§2.4 — não liberada nesta conta).

### 2.5 Comprador acompanha o pagamento

`checkout.sancocore.com.br/status?c=<contratante>&pedido=<id>`. Página
pública, sem login, consulta periódica. É o link permanente entregue
junto do Pix e do boleto.

### 2.6 Operador cadastra um contratante

Entra em `/admin`, passa pelo Cloudflare Access, informa usuário e senha,
preenche nome, URL base da API, chave, URL de webhook, wallet de split e
métodos habilitados.

### 2.7 Operador cria uma subconta na Asaas

Aba Subcontas: dados da empresa ou pessoa, endereço, documento. A Asaas
devolve `walletId`, que é o que faz o split pagar o contratante.

### 2.8 Operador troca a chave de um contratante

Aba Contratantes → o **terceiro ícone ao lado da chave** (setas em
círculo), junto do olho que revela e do quadrado que copia. A tela avisa,
com o nome escrito, que a chave atual para de valer **na hora** e que a
integração do contratante fica parada até o outro lado colar a nova; só
depois de confirmar a troca acontece. A chave nova aparece na mesma
célula, para revelar e copiar.

O ícone fica junto da chave, e não na coluna de ações, porque é ali que
o operador está olhando quando decide trocá-la. Ele só aparece na chave
de contratante: a da subconta é emitida pela Asaas, e quem a troca é o
painel deles.

Existe porque "nunca trocar" não é política de segredo. Chave vaza — vai
para um print, um chat, um log do parceiro —, e antes disso o único
caminho era editar a linha no SQL Editor (que o `README.md` proíbe) ou
recriar o contratante (que o `CONSTRAINTS.md` §1.10 veta quando há
cobrança paga). A chave exposta valia para sempre.

Não há janela de convivência entre chave velha e nova: é troca seca, e é
o que se quer de uma chave queimada. A ordem certa é trocar, copiar,
atualizar do outro lado.

### 2.9 Operador confere o que aconteceu

Aba Métricas (volume, conversão) e aba Webhook (todo evento recebido,
com o payload redigido, e o contador de tentativas recusadas).

---

## 3. Telas

| tela | arquivo | quem vê | protegida por |
|---|---|---|---|
| Checkout | `public/index.html` | comprador | nada — é pública por natureza |
| Status do pagamento | `public/status.html` → servida em `/status` | comprador | só conhecer o par contratante+pedido |
| Fechar pop-up | `public/pagamento-popup-fechar.html` | comprador | nada; só diz "pode fechar" |
| Painel administrativo | `public/admin.html` → servida em `/admin` | operador | Cloudflare Access **+** usuário e senha no backend |
| Termos de Uso | `public/termos.html` | qualquer um | nada |
| Política de Privacidade | `public/privacidade.html` | qualquer um | nada |
| Página não encontrada | `public/404.html` | quem digitou um caminho que não existe | nada; devolvida com status 404 e sem link para o checkout, que sem `?c=` e `?pedido=` só mostraria "indisponível" |

O painel tem cinco seções: **Contratantes**, **Subcontas**, **Métricas**,
**Webhook** e **Arquivados**.

---

## 4. Estados de cada tela

### 4.1 Checkout (`index.html`)

| estado | quando | o que aparece |
|---|---|---|
| Carregando | ao abrir, enquanto resolve o pedido | resumo em branco |
| Pronto | pedido resolvido com valor | resumo, total, métodos habilitados, formulário |
| **Indisponível** | contratante ou pedido não resolvido, **ou resposta sem valor cobrável** — ausente, zero, negativa ou acima do teto | total como **`R$ —`**, nunca `R$ 0,00`, e **nenhum botão de pagamento visível** |
| Pedido encerrado | pedido já pago ou cancelado na origem | mensagem de encerrado; não deixa cobrar de novo |
| Reserva expirada | `expiraEm` no passado | cronômetro zera e a tela diz "Esta reserva expirou." |
| Resultado Pix | após gerar | QR, copia-e-cola, link permanente de status |
| Resultado boleto | após gerar | linha digitável, link do PDF, link permanente |

O estado **Indisponível** é o mais importante e o que já passou
despercebido duas vezes
(`docs/erros/2026-09-11-total-ausente-virou-zero-na-tela.md` e
`docs/erros/2026-09-13-o-guarda-de-total-olhava-o-numero-errado.md`):
ausência de total **nunca** vira zero na tela, e método de pagamento só
aparece quando há valor para cobrar.

**A régua é uma só, e é a do caminho que cobra** (`valorValido`: maior
que zero e até R$ 100.000). Vale para os três lugares onde um número
vira preço:

- a rota que a tela consulta (`GET /pedido/…`) **não devolve taxa** —
  logo, não devolve total — para pedido cuja base não é cobrável. Sem
  isso ela anunciava R$ 1,49 de taxa sobre um pedido de R$ 0,00, e a
  tela ficava comprável;
- a tela do pedido recusa total não finito ou não positivo;
- a tela da assinatura recusa plano sem valor utilizável, com a mesma
  régua, em vez de deixar `R$ 0,00` aparecer com o botão de assinar
  ligado.

Protegido por `tests/total-nao-confiavel-nao-vira-tela-compravel.js`.

### 4.2 Status (`/status`)

Seis estados, com texto próprio cada um:

| status | selo | o que o comprador lê |
|---|---|---|
| `pendente` | Aguardando pagamento | "Assim que o pagamento for identificado, esta página atualiza sozinha." |
| `em_analise` | Em análise | "Recebemos seu pagamento e ele está passando por uma verificação de segurança." |
| `confirmado` | Pago | "Recebemos seu pagamento. A loja já foi avisada." |
| `recusado` | Recusado | "O pagamento não foi aprovado. Volte à loja para tentar novamente, se quiser." |
| `vencido` | Vencido | "O prazo de pagamento passou. Volte à loja para gerar uma nova cobrança." |
| `cancelado` | Cancelado | "Esta cobrança foi cancelada." |

Pedido sem cobrança devolve **404** e a tela mostra erro, não um estado
vazio.

### 4.3 Painel administrativo

Duas telas: **login** e **painel**. Sem sessão guardada em cookie — o
usuário e a senha ficam no `sessionStorage` da aba e vão em todo request
(limite declarado em `CONSTRAINTS.md` §2.6). Backend sem as variáveis de
admin devolve **503**, não 401: "admin desativado" é diferente de "senha
errada".

---

## 5. Regras de negócio

Cada uma com a consequência escrita.

**O valor cobrado vem sempre do contratante, nunca do navegador.** O
corpo da requisição aceita apenas nome, e-mail, documento e telefone. Se
alguém acrescentar um campo de valor ali, o comprador escolhe quanto
paga. Protegido por teste (`tests/valor-vem-do-servidor.js`).

**Taxa é somada por cima, nunca descontada do contratante.** O comprador
paga o valor do pedido mais a taxa da Asaas mais a taxa própria. O
contratante recebe o valor cheio do pedido.

**Um pedido tem no máximo uma cobrança pagável por método.** Recarregar a
página e clicar de novo devolve o **mesmo** Pix. Sem isso, o comprador
consegue dois códigos igualmente pagáveis e paga duas vezes.

**Método não habilitado não cobra.** O contratante declara quais métodos
aceita; o backend recusa os demais mesmo que a requisição peça.

**Contratante arquivado ou desativado para de resolver pedido.** Não é só
sumir da lista: o link antigo deixa de gerar cobrança e a chave dele
deixa de autenticar estorno.

**Contratante nunca é apagado enquanto tiver cobrança paga.** Histórico
financeiro não fica órfão (§1.10).

**Assinatura por Pix Automático não cobra.** O método nasce desmarcado em
contratante novo, porque não está liberado nesta conta Asaas (§2.4).

**Onde a Asaas define um conjunto fechado, o checkout conhece o conjunto
inteiro.** Conjunto enumerado pela metade é a causa raiz recorrente deste
projeto (`docs/erros/2026-09-10-conjunto-enumerado-pela-metade.md`).

**Todo campo vindo de fora tem teto de tamanho**, aplicado antes de
normalizar: nome 2–150, e-mail 254, documento 32, telefone 32, CEP 16.
Longo demais é recusa, nunca truncamento.

**Valor por cobrança: R$ 0,01 a R$ 100.000,00. Parcelamento: 1 a 12.**
Pedido de valor zero não vira cobrança nem com a taxa desligada — o que
seria cobrado é só a taxa, e uma cobrança de R$ 0,00 contaria como
pagamento na métrica da seção 9. Benefício gratuito se libera no projeto
que vende, sem passar pelo checkout (`CONSTRAINTS.md` §1.11).

---

## 6. Textos que o sistema diz

Os do comprador estão na tabela de estados acima. Os de erro, que são os
que mais importam porque aparecem no pior momento:

| situação | texto |
|---|---|
| contratante não existe | "Contratante não encontrado." |
| pedido não existe | "Pedido não encontrado." |
| API do contratante fora do ar | "Não foi possível carregar os dados do pedido, tente novamente." |
| campo obrigatório faltando | "Nome, e-mail e CPF/CNPJ são obrigatórios." |
| documento inválido | "CPF/CNPJ inválido." |
| e-mail inválido | "E-mail inválido." |
| nome fora do teto | "Nome inválido." |
| pedido já encerrado | "Este pedido já está com status \"pago\"." |
| limite de requisições | "Muitas tentativas em pouco tempo. Aguarde um minuto." |
| rota inexistente | "Rota não encontrada." |
| erro nosso | "Erro interno. Tente novamente em instantes." |

**Nenhuma mensagem de erro revela nome de tabela, caminho de arquivo,
versão de biblioteca ou rastro de pilha.** O detalhe vai para o log do
servidor.

---

## 7. Quando dá errado

| falha | o que o sistema faz |
|---|---|
| API do contratante fora do ar | 504, tela mostra indisponível, nenhuma cobrança criada |
| API do contratante devolve pedido sem valor cobrável (ausente, zero ou fora da faixa) | rota do pedido devolve `taxa: null`, tela indisponível, `R$ —`, botões escondidos — nunca um total que é só a taxa |
| API do contratante devolve plano de assinatura sem valor | tela indisponível com o aviso de pedir link novo ao vendedor; o botão de assinar recusa o clique |
| Asaas fora do ar | erro genérico ao comprador, nada gravado como pago |
| webhook com token errado | 401, contado em `webhook_rejeicoes` por hora, sem gravar linha por tentativa |
| webhook de evento não mapeado | gravado como `nao_mapeado` na aba Webhook, resposta 200 para a Asaas não pausar a fila |
| banco fora do ar | erro genérico; cobrança na Asaas pode existir sem linha local — a conciliação (`API.md` 5.2) é a rede |
| duas cobranças simultâneas do mesmo pedido | a segunda reaproveita a primeira |
| chave da Asaas expirando ou apagada | evento `ACCESS_TOKEN_*` vira alerta em `/api/saude` |
| instância sem memória | a fila de derivação impede duas derivações scrypt simultâneas (§2, gargalo 0) |

---

## 8. Direitos e obrigações que viram tela

Aqui a lista muda de forma por causa de um fato do desenho: **o comprador
não tem conta neste sistema, e quem vende não somos nós.** O San Checkout
é infraestrutura de pagamento do lojista (`public/termos.html` §1.4), sem
cadastro, sem login e sem catálogo. Então cada direito cai em um de três
lugares, e o que importa é que a tela diga em qual.

| direito ou obrigação | de quem é | onde está, hoje |
|---|---|---|
| Confirmação da contratação | nossa | resumo com o total antes de pagar (§4.1) e página de status com link permanente, entregue junto do Pix e do boleto (§4.2) |
| Termos e política antes de pagar | nossa | caixa de aceite no checkout, com os dois links |
| Arrependimento em 7 dias (CDC art. 49) | **do lojista** | é ele quem vende (`termos.html` §13.1). Nossa parte é não atrapalhar, executar o estorno que ele autoriza (`POST /checkout/estornar`, `API.md`) e **dizer isso na tela**: rodapé da página de status |
| Acesso, correção, portabilidade e eliminação (LGPD art. 18) | nossa, **por canal** | `juridico@sancocore.com.br`, agora no rodapé do checkout e da página de status — não mais só dentro da política |
| Canal do titular / Encarregado | nossa | mesmo endereço, também em `privacidade.html` §24 |
| Revogação de consentimento | **não se aplica** | o tratamento não se apoia em consentimento, e sim em execução de contrato e obrigação legal (`privacidade.html` §9). Botão de revogar prometeria o que não existe |
| Excluir conta | **não existe conta** | não há cadastro de comprador para apagar. O que existe é o dado da cobrança, com retenção de 5 anos (`docs/inventario-de-dados.md` §6) — apagar antes disso conflita com obrigação fiscal, e é por isso que o pedido passa por um canal que sabe separar os dois casos |
| Exportar os próprios dados por botão | **deliberadamente não** | a página de status abre com o par contratante+pedido, que identifica uma cobrança e **não autentica uma pessoa**. Botão de exportar ali entregaria dado pessoal a quem tiver o id do pedido |
| Ticket de atendimento com auto-resposta | **não existe** | o canal é e-mail (`suporte@`, `juridico@`). Pendência declarada, não bloqueante, em `docs/pendencias.md` |

**Estorno é do lojista, e isso é arquitetura, não omissão.** O checkout
recebe pagamento; a decisão de devolver é de quem vendeu, e chega aqui
como autorização autenticada pela `X-Checkout-Key` dele. Um botão de
desistência nesta tela precisaria decidir, sozinho, se a devolução é
devida — que é exatamente o que este sistema não sabe.

**O que mudou de tela em 13/09/2026:** o rodapé da página de status
passou a dizer, em texto, que cancelamento e arrependimento se resolvem
com a loja e que o estorno volta pelo mesmo meio de pagamento; e o canal
do titular saiu de dentro da política para o rodapé das duas telas do
comprador. Antes disso, quem quisesse exercer um direito tinha que ler
uma política de 28 seções para achar um e-mail.

---

## 9. Métrica de sucesso e eventos

**Sucesso deste motor = cobrança confirmada, contada por contratante.**
Decidido pelo dono em 13/09/2026 e registrado no spec.

O número que se olha: **quantas cobranças foram confirmadas por dia, por
contratante**, e quanto elas somam em valor pago.

Por que este e não os outros dois que estavam na mesa:

- **Taxa de pagamento** (confirmadas ÷ checkouts abertos) mede a
  qualidade da tela, mas o denominador não existe: exigiria gravar uma
  linha por abertura de página e lidar com bot e recarregamento
  (`src/controllers/adminController.js`, `obterMetricas`). Ela continua
  como métrica secundária, calculada sobre o que já **resolveu**
  (pagas ÷ (pagas + perdidas)), que é o que dá para medir sem inventar
  evento.
- **Tempo até o dinheiro cair** é dominado pelo meio de pagamento —
  boleto leva de um a três dias úteis — e mediria a Asaas e o banco, não
  o motor.

**Onde se lê, hoje:** aba Métricas do painel, ou
`GET /api/admin/metricas?dias=N` →
`porContratante[id].pagas`, `.valorPago`, `.taxaPagamento`.

**Limite conhecido:** `dias=N` conta as últimas N×24 h, não dias civis.
"Quantos ontem?" hoje se responde com "nas últimas 24 horas". Janela por
data é pendência declarada, não fingida.

### Os eventos do motor

Nomes reais, os mesmos que o contratante recebe no webhook de saída
(`API.md` 4.3.4) — não uma taxonomia paralela inventada para o relatório:

| evento | quando acontece | onde fica registrado |
|---|---|---|
| `cobranca_criada` | Pix, boleto ou cartão gerado para um pedido | linha em `cobrancas` com status `pendente` (é o denominador de "geradas") |
| **`cobranca_confirmada`** | a Asaas confirmou o pagamento | status `confirmado` em `cobrancas` — **é este que a métrica conta** |
| `cobranca_falhou` | ciclo ou cobrança que não entrou: cartão recusado ou vencimento | status `recusado` ou `vencido` |
| `cobranca_estornada` | devolução autorizada pelo lojista, total ou parcial | status `estornado` |
| `cobranca_contestada` | chargeback | status `chargeback` |
| `criada` / `cancelada` (assinatura) | assinatura com a primeira cobrança paga; assinatura encerrada | tabela de assinaturas e webhook de saída |
| `webhook_rejeitado` | chegou webhook com token errado | contador por hora em `webhook_rejeicoes`, sem uma linha por tentativa (§2.5 do `CONSTRAINTS.md`) |
| `nao_mapeado` | evento da Asaas que ainda não tem tratamento em código | aba Webhook, com o payload redigido |

**Dois eventos que não existem de propósito:** `checkout_aberto` e
`pedido_indisponivel`. Ambos são do navegador, exigiriam gravar linha por
visita e trariam bot junto. Enquanto a pergunta principal for "quantas
cobranças confirmadas ontem, e de quem", a resposta sai de `cobrancas`
sem nenhuma instrumentação nova — e é essa a razão de a métrica escolhida
ser essa.

---

## 10. O que fica fora desta versão

Remete ao `CONSTRAINTS.md` §1, que é o dono da lista: upsell pós-compra,
troca de cartão de assinatura pela API, prova social sintética, timer de
escassez, multimoeda, cashback e order bump com catálogo próprio, estorno
parcial, sandbox para parceiro externo, nota fiscal e e-mail ao
comprador, exclusão física de contratante.

E, de `docs/proximas-versoes.md`: aviso de evento por e-mail e WhatsApp,
tratamento em código dos eventos que hoje só entram no log, detecção de
fila pausada da Asaas, eventos de funil, split na assinatura por Pix
Automático, contador de tentativa por credencial.

---

## Como saber que está pronto

1. **Consigo construir cada tela lendo só isto, sem inventar
   comportamento?** Sim — as seis telas estão listadas com seus estados,
   e os estados do checkout e do status estão enumerados com o texto que
   aparece em cada um.
2. **Cada papel tem jornada completa, e cada tela pertence a alguma
   jornada?** Sim — comprador (2.1 a 2.5), operador (2.6 a 2.9), e o
   contratante não tem tela por desenho, integra por API. As seis telas
   aparecem em alguma jornada.
3. **Cada regra de negócio tem consequência escrita?** Sim — as dez
   regras da seção 5 dizem o que acontece quando são violadas.
4. **Cada fluxo tem o caminho de quando dá errado?** Sim — seção 7, mais
   os estados de erro das seções 4.1 e 4.2 e os textos da seção 6.
5. **Cada direito do comprador tem lugar na tela ou uma razão escrita
   para não ter?** Sim — seção 8, com os três destinos possíveis (nossa
   tela, tela do lojista, canal) e o motivo de cada "não".
6. **Dá para responder "quantos ontem?" com número?** Sim — seção 9:
   cobranças confirmadas por contratante, lidas em
   `GET /api/admin/metricas`, com a ressalva de que a janela é de 24 h e
   não de dia civil.
