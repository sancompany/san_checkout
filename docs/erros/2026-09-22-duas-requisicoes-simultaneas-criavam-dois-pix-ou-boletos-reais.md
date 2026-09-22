# Duas requisições simultâneas podiam criar dois Pix/boletos reais na Asaas

**Quando:** 22/09/2026, achado numa auditoria técnica externa (Codex,
sem acesso de push a este repositório — o dono repassou o relatório).
**Onde:** `src/controllers/checkoutController.js` (`gerarPix`,
`gerarBoleto`).

## O que aconteceu

A ordem até então era: checar se já existe uma cobrança pendente pro
pedido+método (`buscarCobrancaPendenteDoPedido`) → criar a cobrança de
verdade na Asaas (`criarCobrancaPix`/`criarCobrancaBoleto`) → só
DEPOIS gravar a linha local (`registrarCobranca`, um `insert`).

Duas requisições chegando quase juntas pro MESMO pedido+método liam as
DUAS "nada pendente ainda" — nenhuma tinha se registrado localmente —
e as DUAS criavam um Pix/boleto pagável DE VERDADE na Asaas. O índice
único parcial (`idx_cobrancas_pendente_unica`, migration 0001) só
impedia a SEGUNDA LINHA de existir no Postgres; ele nunca impediu o
segundo objeto financeiro de nascer no PSP. O comentário da própria
migration já admitia isso ("a checagem principal é no código... mas
ela tem uma janela de corrida... este índice é o que realmente impede
o segundo REGISTRO" — nunca prometeu impedir a segunda cobrança).

Risco: dois Pix (ou dois boletos) pagáveis pro mesmo pedido — se
alguém pagasse os dois (o antigo mandado por WhatsApp, por exemplo), o
segundo vira estorno manual.

## A correção

Inverteu a ordem: **reservar → cobrar → completar**, o mesmo padrão
que `asaasCheckoutController.js` já usa pro fluxo de pop-up
(`registrarCobrancaPendentePopup`, que cria a linha ANTES de existir
`charge_id`). `cobrancaService.js` ganhou três funções:

- `reservarCobranca` — `insert` mínimo (sem dado do pagador ainda),
  contando com o índice único já existente pra recusar a SEGUNDA
  reserva antes de qualquer chamada à Asaas (`23505`);
- `completarCobranca` — preenche a MESMA linha com os dados reais
  depois que a Asaas confirma;
- `liberarReservaCobranca` — apaga a reserva quando a Asaas recusou de
  forma **limpa** (só nesse caso é seguro: nada foi criado do outro
  lado).

A parte que exigiu mais cuidado: o que fazer quando a chamada à Asaas
falha de um jeito **ambíguo** (timeout, 5xx, 429) — não dá pra saber
se ela processou antes de a resposta se perder. Apagar a reserva
cegamente reabriria a mesma corrida por outra porta (uma nova
tentativa criaria uma segunda cobrança de verdade). A regra virou:
**só libera em recusa limpa (4xx com corpo reconhecido, nunca
timeout/5xx/429)** — mesma regra que `trocaExecucaoService.
iniciarCobranca` já segue pro acerto de troca de plano desde
21/09/2026. Em caso ambíguo, a reserva fica (registrada em Lei 8, com
o pedido nomeado, pra reconciliação manual) — o pedido fica bloqueado
pra uma nova tentativa até alguém resolver, o que é pior experiência
que antes, mas é o único lado seguro.

`checkoutController.js` passou pro padrão de fábrica com `deps`
injetáveis (igual `trocaAprovacaoController.js`/
`trocaExecucaoService.js` já fazem) — sem isso não dava pra testar a
ORDEM sem bater num banco de verdade. Autoteste novo trava: a reserva
acontece antes de chamar a Asaas; uma corrida de verdade (segunda
chamada no MEIO da primeira, sem chargeId ainda) nunca cria uma
segunda cobrança e responde `409`; um F5 depois de a primeira já ter
terminado reaproveita normalmente; recusa limpa libera; timeout/5xx/429
não liberam e ficam em Lei 8.

## Efeito colateral

`tests/sem-consulta-repetida.js` fazia a checagem por regex no texto-
fonte, procurando literalmente `resolverPedido(` — não reconhecia
`deps.resolverPedido(`. Ajustado pra aceitar o prefixo `deps.` (o
contratante continua vindo do MESMO resolvedor, só que via injeção).

## Lição

O comentário que documenta uma proteção precisa dizer exatamente o que
ela protege — "este índice é o que realmente impede o segundo
registro" estava certo e ao mesmo tempo enganoso: quem lesse rápido
concluiria "duplicidade resolvida", quando só a metade estava. A
auditoria achou porque leu a ORDEM das operações, não só o comentário.
