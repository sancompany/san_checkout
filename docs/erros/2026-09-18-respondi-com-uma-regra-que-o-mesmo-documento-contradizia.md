# Respondi com uma regra que o mesmo documento contradizia duas seções abaixo

**Quando:** 18/09/2026, respondendo à pergunta do dono sobre marcar o
grupo `SUBSCRIPTION_*` no painel da Asaas.
**Onde:** `CONSTRAINTS.md` §2.2 (regra 3) contra §2.2 (seção "Grupo
Assinaturas") contra §2.5, todos no mesmo arquivo.

## O que aconteceu

O dono perguntou quais eventos marcar a mais. Achei duas divergências
reais entre o painel e o `CONSTRAINTS.md` (Movimentações Internas
desmarcado, `PAYMENT_CHECKOUT_VIEWED` marcado indevidamente) e, sobre
`SUBSCRIPTION_*`, respondi citando a regra 3 do §2.2: "marcar evento que
o código ignora não é grátis: ele chega, é logado inteiro (payload cru,
com dado pessoal) e é descartado" — e recomendei não marcar agora.

O dono voltou perguntando por que eu tinha recomendado adiar em vez de
marcar, o que me fez reler a seção inteira em vez de confiar na frase
que já tinha citado. E o §2.5, **três parágrafos acima da regra 3 no
mesmo documento**, descreve o oposto: desde a migration `0002`
(11/09/2026), `redigirPayload` (`src/services/auditoriaWebhookService.js`)
redige **todo** evento por lista branca de nome de campo antes de
gravar — `id`, `customer`, `subscription`, nome, e-mail, CPF nunca
entram; só o caminho da chave, sem valor. Conferido no código, não só
no texto: a função roda incondicionalmente na linha 311 do
`webhookController.js`, antes de qualquer chamada de
`registrarAuditoria` — vale para evento tratado e não tratado.

A regra 3 estava desatualizada desde 11/09: nasceu antes da redação por
lista branca existir, e ninguém voltou para corrigi-la quando o §2.5 foi
escrito. Ela ainda citava "pendência aberta no CLAUDE.md" para um
problema que já tinha sido fechado.

## Por que passou

Eu li a seção "Grupo Assinaturas" inteira antes de responder — ela cita
a regra 3 por número ("exige medir antes de codificar... `docs/
pendencias.md`") e eu confiei na citação sem reler o texto da regra
citada. **Citação não é verificação**: a mesma armadilha de qualquer
outra vez que este projeto tratou um documento como fonte sem ler a
fonte primária — só que desta vez a "fonte primária" era **o mesmo
arquivo**, duas seções abaixo.

## A regra que fica

**Quando duas seções do mesmo documento descrevem o mesmo mecanismo,
ler as duas antes de responder — citar uma pela referência ao número
não é reler o conteúdo.** Regra desatualizada dentro do próprio
documento que se declara "referência única" é o pior caso: o leitor
confia justamente porque o documento se anuncia como fonte única, e o
erro fica invisível até alguém perguntar "por que não?" em vez de
aceitar a resposta.

Corrigido: a regra 3 do §2.2 agora remete ao comportamento real
(redação por lista branca, sem custo de dado pessoal), e a seção do
grupo Assinaturas passou a recomendar marcar o grupo inteiro — a razão
para não marcar já não existia desde 11/09, só ninguém tinha voltado
para apagá-la.

**Ecossistema:** sim — vale para qualquer projeto cujo documento de
regras cresce por seções escritas em dias diferentes: a seção nova
corrige o comportamento, mas a seção velha que cita o comportamento
antigo não é reescrita sozinha.
