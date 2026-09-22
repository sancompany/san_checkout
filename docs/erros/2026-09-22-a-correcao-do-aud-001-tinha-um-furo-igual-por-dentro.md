# A correção do AUD-001 tinha o mesmo furo por dentro de `criarCobrancaPix`, e mais dois achados de revisão automática

**Quando:** 22/09/2026, revisão automática do Codex (GitHub App,
`chatgpt-codex-connector[bot]`) sobre a PR #39 (que já continha as
correções do AUD-001, AUD-007 e AUD-005).
**Onde:** `src/services/asaasService.js` (`criarCobrancaPix`,
`foiRecusaLimpaDaAsaas`), `src/controllers/checkoutController.js`
(`gerarReferenciaExterna`, `cobrarComReserva`), `src/services/
cobrancaService.js` (`completarCobranca`, `liberarReservaCobranca`).

## Achado 1 (P1, o mais grave): o furo do AUD-001 reaberto por dentro do `criarCobrancaPix`

A correção do AUD-001 (reservar → cobrar → completar) parte da premissa
de que uma chamada a `criarCobrancaPix`/`criarCobrancaBoleto` ou dá
certo (cobrança criada) ou falha inteira (nada criado) — e classifica
qualquer 4xx-com-corpo como "recusa limpa, pode liberar a reserva".

**Falso para `criarCobrancaPix`.** A função faz DUAS chamadas: `POST
/v3/payments` (cria o pagamento de verdade) e depois `GET .../
pixQrCode` (só busca o QR pra mostrar). Se a SEGUNDA falhasse com um
4xx — um 404 transitório enquanto o pagamento propaga do lado da
Asaas, por exemplo —, `foiRecusaLimpaDaAsaas` classificava isso como
"nada foi criado" e liberava a reserva. Mas o pagamento **já
existia**. Uma nova tentativa do comprador criaria um SEGUNDO Pix real
— o mesmo furo que o AUD-001 fechou, reaberto por outra porta dentro
da mesma correção.

`criarCobrancaBoleto` não tinha este problema: a segunda chamada dela
(`GET .../identificationField`, busca a linha digitável) já estava
dentro de um `try/catch` que nunca propaga — swallow deliberado, porque
o `bankSlipUrl` da criação já é suficiente sem a linha digitável.

**Correção:** `criarCobrancaPix` agora envolve a busca do QR Code no
próprio `try/catch`, e qualquer falha ali marca o erro com
`erro.pagamentoJaCriado = true` antes de relançar.
`foiRecusaLimpaDaAsaas` (extraída pro `asaasService.js` no AUD-007)
ganhou uma checagem que essa marca vence QUALQUER status — nunca é
"limpa" quando o pagamento já existe do lado de lá, seja qual for o
código HTTP da segunda chamada.

## Achado 2 (P1): a referência pra reconciliação manual não sobrevivia a lugar nenhum

Quando a falha é AMBÍGUA (timeout, 5xx — caso em que a reserva fica
travada de propósito), a mensagem registrada em Lei 8 dizia "confira na
Asaas por externalReference" — mas o `externalReference` mandado pra
Asaas era `${documento}-${Date.now()}`, um valor que não era persistido
em lugar NENHUM além do corpo daquela requisição. Quem fosse
reconciliar na mão não tinha como saber qual `externalReference`
procurar.

**Correção:** `referenciaExterna` passou a ser derivada do id da
RESERVA local (`reserva-${reserva.id}`) — que já É persistido, é a
própria linha em `cobrancas`. `cobrarComReserva` agora passa
`reserva.id` pro callback `cobrar(reservaId)`, e a mensagem de Lei 8
nomeia o valor exato a procurar.

## Achado 3 (P2): falha ao LIBERAR a reserva ficava muda

`liberarReservaCobranca` só logava no console se o `delete` falhasse —
e nesse caso a linha `pendente` sem `charge_id` ficava travada pra
sempre (o índice único nunca libera esse pedido+método pra uma nova
tentativa, e `buscarCobrancaPendenteDoPedido` nunca reaproveita uma
linha sem `charge_id`). Isso acontece justamente no caso em que a Asaas
recusou de forma LIMPA — ou seja, o pedido do comprador simplesmente
fica preso, sem sintoma nenhum além de 409 pra sempre.

**Correção:** registra em Lei 8 quando o `delete` falha, com a
recomendação explícita de apagar a linha na mão. Diferente do caso
ambíguo (onde a reserva TEM que ficar), aqui a resposta que volta pro
cliente já é um erro — não existe resposta boa a atrasar, então a
escrita é esperada (`await`), não fire-and-forget.

## Efeito colateral: `completarCobranca` deixou de esperar a escrita de Lei 8

Revendo a mesma área, `completarCobranca` (que roda DEPOIS de a Asaas
já ter confirmado o pagamento) esperava (`await`) a escrita em Lei 8
antes de devolver — atrasando a resposta pro pagador que já tem QR/
boleto em mãos, por um problema que é só nosso (a linha local
incompleta, não o pagamento). Como `registrarErro` nunca lança (engole
a própria falha por desenho), trocar para fire-and-forget não cria
promessa rejeitada sem dono.

## Lição

Uma função de serviço que "cria uma cobrança" pode, por dentro, fazer
MAIS de uma chamada de rede — e um classificador de erro que olha só o
status HTTP da última chamada não sabe se um efeito colateral real já
aconteceu antes dela. A guarda certa não é "todo 4xx com corpo é
seguro" — é "a função que sabe o que já foi criado marca o erro", e o
classificador respeita essa marca antes de olhar qualquer outra coisa.
