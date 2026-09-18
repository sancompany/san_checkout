# Pendências de conformidade — San Checkout

Lista completa. O `CLAUDE.md` aponta para cá e guarda só o que bloqueia a
esteira — ele é índice e cabe numa tela; esta é a lista de trabalho.

**Fechar uma pendência é reescrevê-la em 🟢, com o que ERA e o que passou
a ser** — não apagá-la nem riscá-la. Esta linha dizia "é removê-la
daqui", e o arquivo nunca fez isso: são quinze entradas verdes mantidas,
e mantê-las é o certo. A entrada fechada guarda o motivo, e o motivo é
o que impede alguém de reabrir o mesmo buraco em seis meses achando que
foi esquecimento. A regra foi alinhada à prática em 17/09/2026.

O que NÃO pode ficar é entrada aberta descrevendo trabalho já feito —
disso este arquivo teve um caso de três dias (o ciclo de segurança sobre
o Northflank), e é o pior dos dois erros: manda refazer.

---

## Bloqueiam a esteira

### 🟠 Estação 5 · o pagamento em produção ainda aponta para o sandbox
A lei nova diz que o deploy da Estação 5 é "produção de verdade, não
ensaio — apontando para o ambiente real dos provedores, inclusive
pagamento", porque identificador, formato de webhook, assinatura e erro
mudam entre ambientes. Hoje `ASAAS_AMBIENTE=sandbox`.

**Virou exceção registrada em 13/09/2026**, que é o caminho que a
própria lei prevê: `CONSTRAINTS.md` §3, "Estação 5 · deploy em produção
apontando para o sandbox da Asaas". Lá está a leitura do dono (servidor
e subdomínio no ar cumprem a regra; as variáveis são decisão dele), o
plano de duas rodadas e o custo assumido.

Esta entrada fica aberta até a **segunda rodada**: variáveis em
produção, e os quatro pontos que mudam entre ambientes — identificador
de cobrança, formato do webhook, assinatura e mensagem de erro —
reconferidos um a um. O que a troca envolve está no fim deste arquivo
("Ao trocar o Northflank para produção").

### 🟡 Lei 3 · custo do scrypt no Northflank — medido em 14/09, no teto
`seguranca-san/references/senha-e-kdf.md` manda calibrar mirando 0,5 a
1 s por hash **medido no servidor real**. Medido em 14/09 por subtração
de latência (login falho em `/api/admin/sessao`, que roda uma derivação,
menos a baseline de rede de uma rota sem scrypt): login ~1,8–3,1 s,
baseline ~0,8 s → **scrypt ≈ 1,0–1,3 s** no Northflank (0,5 vCPU),
contra os ~830 ms do Render. Medida com ruído de rede (não é
microbenchmark no servidor), mas é o "no servidor real" que a lei pede.

Fica **no teto ou pouco acima** de 1 s. Não é deficit — é margem: mais
caro por tentativa é mais forte contra força bruta, o login é assíncrono
(não trava o event loop, `sessaoAdmin.js`) e é raro. **Recomendação:
manter N=2^17.** Baixar N para caber em ≤1 s enfraqueceria o hash sem
ganho real. Decisão do dono se quiser mirar o meio da faixa.

### 🟢 Estação 6 · o ciclo de segurança sobre o Northflank — FEITO 14/09
Era: o ciclo 1 rodou em 11/09 contra o Render, em Oregon, e a produção
ficaria no Northflank, em São Paulo, com CDN na frente e outra topologia
de proxy — então o ciclo precisava ser repetido sobre o que está de fato
no ar. **Foi repetido em 14/09** e o resultado está no `CLAUDE.md`
("Segurança de fora"): Supabase RLS default-deny, admin fail-closed, IDOR
401/403 ao vivo, erro genérico, webhook fail-closed. Achou dois furos,
os dois corrigidos e no ar (`alvoDeRede` e o `search_path` da migration
0004), e derrubou a hipótese da origem-bypass
(`docs/erros/2026-09-14-origem-direta-alcancavel-por-fora.md`).

Esta entrada ficou três dias dizendo "precisa rodar" DEPOIS de ter
rodado. Documento falso é pior que documento ausente: quem lesse a lista
de pendências planejaria de novo um trabalho já feito.

### 🟢 Estação 6 · ponta a ponta de seis passos (Pix) — FEITO 14/09
Os seis passos rodaram ao vivo no sandbox contra o `testemaster`, com
`ped_completo` (R$9,50; `ped_teste` de R$1 é recusado pelo piso de R$5
da Asaas — ver a entrada própria):

1. resolve pelo pull (`taxa` calculada);
2. Pix pago pelo dono → `RECEIVED`;
3. webhook processado (auditoria 9→10; cobrança → `confirmado`);
4. status público reaberto → `confirmado`, R$11,08;
5. conciliação autenticada (`X-Checkout-Key`) → `confirmado`, taxas batem;
6. estorno → `estornado`, 200 (primeira vez ao vivo; `refundController.js`).

Negativos conferidos ao vivo: chave inválida → 401; chave certa +
contratante trocado na URL → 403 (IDOR).

**Assinatura, 14/09:** a criação da sessão funciona ponta a ponta —
`POST /assinatura/testemaster/plano_anual` (R$10) devolve o `checkoutUrl`
do pop-up. Os endpoints de ciclo (`consultar/cancelar/pausar/retomar-assinatura`)
respondem certo na auth (401 sem chave) e no 404 (sem assinatura ativa).
**Falta a metade paga:** completar o cartão no pop-up para nascer a linha
em `assinaturas` e então exercitar pausar/retomar/cancelar contra uma
assinatura viva — precisa de navegador + cartão de teste, assistido pelo
dono, e será retestado pela própria MostrAí na Estação 6 dela. O ramo
assíncrono do estorno de boleto também não foi exercitado.

**Assinatura, 16/09 — varredura de fixture (sem tocar a assinatura real
da MostrAí):** criada uma linha descartável em `assinaturas`
(`testemaster`/`plano_trimestral`, `QUARTERLY`, `ativa`, id falso) para
exercitar o que não depende de cartão real:

- **Vínculo da renovação:** `POST /assinatura/testemaster/plano_trimestral`
  com `renovar: true` gravou `substitui_assinatura_id` apontando pra
  fixture na cobrança nova — confirma que `buscarAssinaturaAtiva` e o
  relay do RN-19/20 continuam corretos depois das correções de 15/09.
- **Erro da Asaas não vira estado local inconsistente:** `pausar-` e
  `cancelar-assinatura` contra a fixture (id que não existe na Asaas de
  verdade) devolveram erro da própria Asaas sem crashar — e, mais
  importante, **sem** atualizar o status local antes de confirmar
  (`alterarStatusAssinatura` falha primeiro; `atualizarStatusAssinatura`
  nunca roda). Conferido direto no banco: a fixture ficou `ativa` depois
  das duas tentativas, sem "cancelada"/"pausada" fantasma.
- Fixture e a cobrança de teste gerada foram apagadas depois.

Continua faltando o mesmo de sempre: cartão real no pop-up para nascer
uma linha "de verdade" e cancelar/pausar/retomar contra ela.

O contratante de teste **já existe**, cadastrado pelo dono em 13/09:

| campo | valor |
|---|---|
| id / nome | `testemaster` / TesteMaster |
| API do pedido | `https://contratante-teste.brunosanches-bhs.workers.dev` |
| webhook | a mesma URL, em `/webhook` |
| wallet de split | vazio — sem split, tudo na conta-mãe |
| métodos | Pix, boleto, cartão e assinatura (assinatura por Pix desmarcada, §2.4) |

Os três links que ele expõe, e o que cada um serve para verificar:

- `…/index.html?c=testemaster&pedido=ped_teste` — o caminho normal
- `…/index.html?c=testemaster&assinatura=plano_mensal` — recorrência
- `…/index.html?c=testemaster&pedido=ped_sem_valor` — o estado
  **indisponível**, que é o que nunca pode virar `R$ 0,00` (§4.1)

O passo do estorno se faz como na vida real — a autorização parte do
lojista de teste, com a `X-Checkout-Key` dele, porque é assim que estorno
acontece aqui (`docs/funcional.md` §8).

O `ped_sem_valor` revelou, em 13/09, dois furos de tela comprável sem
valor cobrável — corrigidos e conferidos
(`docs/erros/2026-09-13-o-guarda-de-total-olhava-o-numero-errado.md`).

---

## Abertas, não bloqueiam

### 🟡 Prontidão item 6 · o RUNBOOK foi escrito, TESTADO por um leitor sem contexto, e corrigido — 17/09, metade virou atualização futura em 18/09
As sete seções que a prontidão operacional exige e que **não existiam**
foram escritas em 17/09: inventário de contas (§1.1), segredos e como
rotacionar cada um (§1.2), alerta → significado → primeira ação (§6.3),
incidente com dado pessoal e os prazos da ANPD (§8.1), dependências
externas e o que cada queda derruba (§9), contatos (§10) e como desligar
tudo com segurança (§11). Deploy, reversão e restauração já existiam.

**E aí o arquivo foi testado, que é a parte que faltava em toda vez
anterior.** Como não existe pessoa número dois, o teste rodou com um
**agente sem nenhum contexto da sessão**, autorizado a ler só o
`RUNBOOK.md` e proibido de executar escrita. Ele respondeu sozinho "está
no ar, e onde roda" e achou o vencimento do domínio; **não conseguiu
publicar**, e travou em oito pontos — os oito viraram correção no mesmo
dia, com a tabela em `RUNBOOK` §10.

Quatro deles causariam dano se alguém os seguisse: §6 mandava aplicar as
migrations `0001…0006` quando existem **nove** (restore sem a tabela de
erros, sem `confirmado_em` e sem `ambiente`/`e_teste`); o comando
"seguro" do §1.2 listava **10 de 11** variáveis e comia justamente a
`ASAAS_AMBIENTE`, que é a da troca para produção; a conferência da URL
do webhook não dizia o método, e **com `GET` o certo e o errado
respondem 404 igual** (só o `POST` distingue: 401 × 404); e a §4 mandava
`git revert <sha-ruim>` sem existir, em nenhum lugar do arquivo, como
saber **qual commit está no ar**.

E dois defeitos que eu tinha escrito horas antes: o comando de listar
variáveis (acima) e um `northflank logs …` que **não existe** — o CLI
não tem comando de log. Os dois entraram por eu ter escrito comando sem
rodar, e é a mesma lição do "evidência sem controle não é evidência",
aplicada a documentação: **comando não conferido é comando falso.**

A regra nova, no próprio arquivo: depois de qualquer edição grande no
RUNBOOK, rodar um leitor sem contexto — pessoa quando houver, agente
enquanto não houver.

O que **só o dono preenche**, e está marcado `⬜` no próprio arquivo:
e-mail de login de cada conta, onde a senha e o segundo fator moram,
qual cartão paga o quê, e o contato direto dele. Sem isso as seções
descrevem a forma e não servem na hora — que é o oposto do objetivo.
**Decisão do dono em 18/09:** ele preenche isso sozinho, depois de
fechar o MostrAí e o checkout, guardando as credenciais num lugar seguro
próprio (site ou anotação já existente) — não depende de mim nem de
pessoa número dois.

**O item só fecha de verdade com a pessoa número dois**, e o teste é o
da própria prontidão: ela, com o runbook e sem falar com quem construiu,
faz um deploy trivial, reverte, e acha a data de vencimento do domínio.
**Não existe pessoa número dois hoje, e o dono decidiu em 18/09/2026
adiar isso — vira atualização futura**
(`docs/proximas-versoes.md`, "Pessoa número dois — operar sem o dono"),
não pendência bloqueante: não é falta técnica, é decisão de quem e
quando. O teste com o agente sem contexto (acima) já mediu a metade que
dá para medir sem credencial; a que falta só fecha com uma pessoa de
verdade.

Medido no dia, e escrito no arquivo: domínio `sancocore.com.br` vence
**31/08/2027** (RDAP do registro.br); projeto Supabase
`zacuaroarelaqnzjjlcz` em `sa-east-1`; Northflank publica de `main`; e
os dois workflows do CI **não usam segredo de repositório** nenhum.

### 🟢 Prontidão item 5 · `Cache-Control`, retenção de log e imagens — 17/09
O item pede quatro coisas, e três estavam feitas ou eram do dono. O que
faltava:

- **`Cache-Control` não existia em resposta nenhuma da API.** Agora toda
  resposta de `/api` sai com **`no-store`** — e não `no-cache`, que
  autoriza guardar e só exige revalidar. O que passa por ali é pedido de
  uma pessoa, status que muda de segundo a segundo e painel autenticado:
  sem o header, quem decide guardar é o navegador e qualquer
  intermediário, pelo palpite dele. Dois efeitos concretos que isso
  evita: o botão "voltar" repintando um pedido já pago como pendente, e
  um proxy compartilhado servindo o pedido de um comprador para outro.
  Coberto em `tests/rotas-http-respondem-como-prometido.js`, na pilha
  montada, **com controle positivo de que fora de `/api` o header não é
  aplicado** — senão a correção mataria o cache do front sem ninguém
  ver. O front tem política própria no `public/_headers` (revalidar
  sempre), e ela já existia.
- **O logo era um PNG de 1378x1378 e 127 KB exibido com 32 px de
  altura**, na primeira tela do comprador, em dado móvel. Passou a ser
  um de 192 px e **8,9 KB** (93% menos), gerado por redução no próprio
  Chromium e conferido a olho contra o original. O arquivo grande
  continua servindo o `og:image`, que é o único lugar onde tamanho
  grande tem função. Os `<img>` ganharam `width`/`height`, que dão a
  proporção antes do download e evitam reflow.
  Travado por **orçamento de 30 KB por imagem** em
  `npm run desempenho`: passada estática que lê o HTML das telas do
  comprador e reprova imagem acima do teto — sem ela, alguém aponta o
  `src` de volta para o arquivo grande e ninguém vê, que é exatamente
  como ele chegou lá.

**Já estava pronto, conferido no mesmo dia:** a retenção de log é
definida e finita em três lugares (`webhook_eventos` 90 dias, amostras
de rejeição 30 dias, tabela `erros` 30 dias, e as linhas de
`webhook_rejeicoes` são agregadas, no máximo 24 por dia). **Do dono:** o
alerta de orçamento nas contas pagas, que virou atualização futura por
decisão dele.

### 🟢 Prontidão item 4 · LCP, INP e CLS medidos — e o CLS da assinatura estava 4x fora — 17/09
`npm run desempenho` (`scripts/desempenho.mjs`) abre um Chromium de
verdade num funil de celular — **CPU 4x mais lenta, 1600 kbps de
download, 150 ms de latência, viewport 390x844** —, mede as cinco telas
do comprador em 5 rodadas cada e falha com código 1 fora do orçamento
(LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1 — os limiares "bom" do Core Web
Vitals).

**O que este número é, e o que não é:** é laboratório, e o "p75" é sobre
as RODADAS, não sobre usuários. Campo exigiria visitante real, e não há:
o checkout está em sandbox e sem divulgação. O que se ganha aqui é um
orçamento reprodutível, que cai junto com uma regressão.

**Correção de uma frase que eu escrevi errada neste mesmo dia:** eu
havia escrito que "o projeto não tem analytics de terceiro". Tem — o
**Web Analytics da Cloudflare** está ativo no domínio das telas (a CSP
libera `static.cloudflareinsights.com` desde 09/09, e o relatório de
segurança daquele dia registra o script carregando). Ele é sem cookie e
sem perfil, e **reporta Core Web Vitals de visitante real**: é onde o
p75 de campo vai aparecer quando houver tráfego. O painel é do dono.
Entrada própria abaixo, porque isso levanta uma pergunta de política de
privacidade.

Medido em 17/09/2026, **depois** das duas correções que a própria
medição pediu (o CLS da assinatura, abaixo, e o logo de 127 KB do item
5) — cinco telas dentro do orçamento, cinco rodadas cada:

| tela | LCP | INP | CLS | antes das correções |
|---|---|---|---|---|
| Checkout · pedido avulso | 684 ms | 32 ms | 0,063 | 632 ms · 32 ms · 0,064 |
| Checkout · assinatura | **1 256 ms** | ≤ 16 ms | **0,033** | 1 560 ms · ≤ 16 ms · **0,409** |
| Status do pedido | 544 ms | 16 ms | 0,013 | igual |
| Termos de Uso | 572 ms | ≤ 16 ms | 0,000 | igual |
| Política de Privacidade | 600 ms | ≤ 16 ms | 0,000 | igual |

O LCP do avulso subiu 52 ms e o da assinatura caiu 304 ms: são rodadas
diferentes num funil emulado, e variação nessa ordem é ruído do
laboratório, não regressão — dizer que o logo "melhorou o LCP em 304 ms"
seria ler sorte como resultado. O que a troca do logo garante é peso:
127 KB → 8,9 KB, que é medida, não estimativa.

**O defeito que a medição achou:** a tela de assinatura tinha CLS de
**0,409**, quatro vezes o teto. O diagnóstico saiu do próprio script,
que reporta QUEM deslocou: o fieldset de endereço era revelado **depois**
da ida à rede, e ele empurrava para baixo o bloco de pagamento, o aceite
dos termos e o botão — 0,4 de deslocamento na parte da tela onde o dedo
já está indo. Como o endereço **não depende da resposta** (assinatura é
sempre cartão), revelá-lo antes do `await` resolve sem esconder nada:
0,409 → **0,033**, reconferido no mesmo funil. No caminho de erro ele
volta a se esconder — formulário que não pode ser enviado não fica na
tela pedindo CEP.

**Duas coisas que a primeira versão do script fazia errado**, e valem
como lição sobre medir: ela mandava clicar em `#method-assinatura`, que
não existe, e reportava "não mediu" como cinco rodadas estouradas; e
tratava "nenhuma entrada de evento" como falha, quando o observador de
INP tem **piso de 16 ms** e interação mais rápida que isso não gera
entrada nenhuma. As páginas legais foram reprovadas por serem rápidas.
Agora um contador de cliques separa "não interagiu" de "interagiu abaixo
do piso".

### 🟢 A conciliação reconfere o `valor` da assinatura — DECIDIDO E CORRIGIDO 18/09
**O que ERA:** a conciliação (`API.md` §5.3) reconferia `status`, `ciclo`
e `proximaCobranca` contra a Asaas e **não** reconferia `valor` — ele
saía do nosso banco. Como a Asaas aceita alterar `value` de uma
assinatura ativa (medido em 17/09) e **nada nos avisa**
(`SUBSCRIPTION_*` fora dos 53 eventos, `PAYMENT_UPDATED` desmarcado de
propósito, §2.2), um preço mudado no painel dela deixava o nosso
registro errado **para sempre e sem sintoma**. Mesma família do bug do
`ciclo` de 15/09: a correção de 16/09 fechou `ciclo` e deixou `valor`.

Ficou **declarado em vez de corrigido às cegas** porque a escolha era do
dono, entre duas coisas defensáveis: reconciliar (a Asaas passa a mandar
no número, inclusive quando a alteração de lá foi erro humano) ou manter
o nosso e denunciar a divergência.

**O que passou a ser:** o dono decidiu **reconciliar**, em 18/09/2026, e
mandou eu fechar com a minha recomendação se discordasse. Não discordo —
e a recomendação acrescentou a segunda metade: **reconciliar E
denunciar**, porque as duas nunca foram alternativas.

- quem debita o cartão é a Asaas, então um número nosso diferente do
  dela não é opinião divergente: é **informação falsa**. Guardar o valor
  antigo para "não endossar o erro" troca um erro de preço por um erro
  de registro, e deixa mentindo justamente o campo que o integrador lê;
- e corrigir **calado** trocaria o número errado por uma **mudança
  invisível** — o contratante é quem fala com o assinante (RN-35), então
  ele recebe `divergenciaDeValor: { nosso, asaas }` na mesma resposta.

Detalhes que a implementação teve de acertar, cada um com sabotagem
provando: comparação em **centavos** (em reais, `30.000000000000004`
seria divergência e a "correção" reescreveria a linha a cada
conciliação); **Asaas sem `value` mantém o nosso** (anular seria a classe
"ausência virou zero"); e 404 ou Asaas fora do ar devolvem o valor do
banco **sem** denunciar divergência — `null` ali significa "não
comparei", não "estava igual".

**No ar desde o `3ec6454`** (PR #20 — é o commit de código; os commits de documento que vieram depois não mudam o que é servido, e o sha servido no momento sai do comando do `RUNBOOK` §3), e a conferência depois da mescla foi
esta: o `deployedSHA` do Northflank é o commit da `main`; o arquivo
servido tem `dinheiroOuNulo` e `divergenciaDeValor` (com controle
negativo de que um padrão inexistente conta zero); o autoteste do
controlador roda **dentro do contêiner de produção** e dá 37 checagens
OK; e, de fora, `/api/saude` responde 200, `consultar-assinatura` sem
chave dá 401, com chave falsa dá 401 `Chave inválida.` (não 500) e um
caminho inventado dá 404.

**✅ Fechado em 18/09, depois de o dono liberar a permissão.** A chamada
real rodou **dentro do contêiner de produção**, importando o MESMO
cliente Supabase e o MESMO `assinaturaAtualizada` que a rota usa (nenhuma
credencial nova, nenhum dado pessoal desceu para disco — só id truncado,
`status`, `ciclo`, `valor` e `divergenciaDeValor`, nunca o documento):

```
3 assinaturas lidas (id truncado + só o que a conciliação reconcilia)
{"id":"sub_j87cq5…","antes":{"status":"ativa","ciclo":"QUARTERLY","valor":267.3},"depois":{"status":"ativa","ciclo":"QUARTERLY","valor":267.3,"divergenciaDeValor":null}}
{"id":"sub_qut652…","antes":{"status":"cancelada","ciclo":"YEARLY","valor":10},"depois":{"status":"cancelada","ciclo":"YEARLY","valor":10,"divergenciaDeValor":null}}
{"id":"sub_xjsad6…","antes":{"status":"ativa","ciclo":"QUARTERLY","valor":537.3},"depois":{"status":"ativa","ciclo":"QUARTERLY","valor":537.3,"divergenciaDeValor":null}}
```

As três batem (`divergenciaDeValor: null` nas três) — inclusive
`sub_j87cq5…` (MostrAí), que já tinha sido reparada em 16/09 e segue
`QUARTERLY`/`267.3` sem drift. **Isto não é controle positivo** — nenhuma
das três tinha divergência de verdade para achar, então o resultado só
prova que o código roda sem erro contra o payload real da Asaas e não
inventa divergência onde não há. Quem prova a detecção em si já foram as
8 sabotagens do autoteste (`Number(null)` incluído); fabricar uma
divergência real em produção para um controle positivo violaria a regra
de nunca tocar a assinatura real do MostrAí e nunca escrever dado de
teste em produção sem plano de limpeza — por isso não foi feito.
Script apagado do contêiner depois (`/tmp`, nunca persistido).

**O que continua aberto, e é menor:** não há aviso **proativo**. Quem
muda o preço no painel da Asaas não dispara nada, e o contratante
descobre na conciliação seguinte. Fechar isso dependeria de marcar o
grupo `SUBSCRIPTION_*` (ou `PAYMENT_UPDATED`), que é decisão de
configuração do dono e está registrada em `CONSTRAINTS.md` §2.2 —
depende de payload real para ser decidida.

### 🟢 Trocar de plano numa assinatura já ativa — CONSTRUÍDO 17/09
**O que ERA:** entrada em `docs/proximas-versoes.md`, com o motivo
errado ("a Asaas congela `valor` e `ciclo`") corrigido por medição no
mesmo dia, e sete decisões em aberto. **O que passou a ser:**
`POST /api/checkout/trocar-plano` no ar do lado do código
(`API.md` §5.6, RN-35 e RN-36, migration 0010) — o dono respondeu as
sete e mandou construir **nesta versão**: *"isso eu estou falando pra
fazer nessa mesmo"*.

Vale registrar por que ela saiu de "próxima versão": a decisão anterior
(16/09, o MostrAí seguir pelo pedido avulso) havia sido tomada sobre uma
afirmação minha que era falsa. Corrigida a afirmação, a decisão voltou
para ele — e mudou.

**As sete regras dele, em uma linha cada** (a fonte é o cabeçalho de
`src/services/proporcionalService.js`, que é o código que faz a conta):
absorver acerto abaixo de R$ 5,00; não devolver nada para baixo; recusar
a troca com cobrança do período pendente; crédito que **não acumula**
(cada troca recalcula sobre o valor pago); mês comercial de 30 dias e
ano de 360; acerto só para cima; e **avisar o assinante é obrigação de
cada contratante**, por e-mail e por aviso no site.

**O que ficou DECLARADO, não construído** — e nenhum tem dano ativo:

1. **Acerto estornado ou contestado depois da troca não reverte o
   plano.** O status da cobrança é atualizado (o receptor grava), mas
   nada desfaz a troca: reverter sozinho tiraria o plano de quem já está
   usando. É decisão de operação, e o caminho manual existe (trocar de
   volta). T13 do mapa.
2. **Troca de plano em assinatura por Pix Automático** com acerto a
   cobrar: recusada com `409`, porque não há cartão salvo e cobrar
   exigiria interação do assinante. Sem dano — o Pix Automático está
   desligado nesta conta (`CONSTRAINTS.md` §2.4).
3. **Não existe tela.** A troca é rota servidor-a-servidor, como
   cancelar/pausar/retomar: quem aciona é o contratante. Ninguém pediu
   tela, e o pagador não decide o próprio plano pelo checkout.

### 🟢 Web Analytics declarado na política, e a política parou de nomear o Render — FECHADO 17/09
Achado escrevendo o item 4: a CSP do `public/_headers` libera
`static.cloudflareinsights.com` (script) e `cloudflareinsights.com`
(conexão), e o relatório de 09/09 registra o script carregando de
verdade. O beacon **não está no HTML** — a Cloudflare injeta sozinha nos
domínios que ela serve —, e é por isso que ele não aparece procurando no
repositório.

`public/privacidade.html` não cita analytics nenhum, e o
`docs/inventario-de-dados.md` também não. Pela orientação da ANPD que a
skill `legal` traz, analytics **sem cookie e sem perfil** não exige
banner de consentimento — mas exige **o aviso na política**. Então não é
o caso de tirar o beacon: é o caso de a política dizer que ele existe,
o que ela não diz.

**FECHADO no mesmo dia, por ordem do dono de resolver sem ele.** As duas
coisas que faltavam foram feitas:

1. **Confirmado pela API, não pelo painel** (`GET /accounts/{id}/rum/site_info/list`):
   o serviço está **ativo** na zona `sancocore.com.br`, com
   `auto_install: true` e `enabled: true`, criado em **01/09/2026**. É a
   Cloudflare que injeta o beacon nas páginas que ela serve — e
   `checkout.sancocore.com.br` é servida por ela (Pages, `proxied`).
   `api.sancocore.com.br` **não** é: é DNS-only, então ali não há beacon.
2. **Política de privacidade na versão 3**, com o aviso escrito
   (§15.5 a 15.9): o que o serviço coleta, que **não usa cookie**, que
   por isso não há pedido de consentimento — só o aviso, na forma que a
   orientação da ANPD prevê —, a base legal, e o fato de que **o prazo
   de guarda é da Cloudflare e a documentação pública não o declara**,
   então não inventamos prazo. A v2 foi arquivada em
   `docs/legal-arquivado/`, e o `inventario-de-dados.md` §5 ganhou a
   linha do Web Analytics e a do Access.

**E a mesma leitura achou coisa pior que a ausência do aviso:** a
política **nomeava o Render** como infraestrutura de aplicação (§15 e
§18.2), e o Render deixou de ser usado em 12/09 — documento legal
apontando o fornecedor errado aponta a transferência internacional
errada. Também prometia comunicação transacional ao Pagador
("confirmação de pagamento", "atualização de status") que o sistema
**não faz**: não há biblioteca de envio no `src/`, e as notificações da
Asaas ao comprador são desligadas por padrão. As duas coisas foram
corrigidas na v3, e o inventário parou de dizer Render também.

**Continua do dono, e é da Estação 7:** revisão do texto por advogado,
que a própria skill `legal` exige para projeto que movimenta dinheiro.
O que eu fiz foi alinhar o documento ao que o sistema faz — não dar
parecer.

De brinde, é a resposta para o p75 de **campo** do item 4: ele vai
aparecer nesse mesmo painel quando houver visitante real.

### 🟢 A zona `sancocore.com.br` tem SPF — APLICADO 18/09
**O que ERA:** a zona tinha DKIM (seletor `google`) e `_dmarc` com
`v=DMARC1; p=reject`, e **nenhum registro `v=spf1`** — conferido em dois
resolvedores independentes em 17/09. Passou pela conferência do item 1 da
prontidão porque, com DKIM válido, o DMARC passa por alinhamento de DKIM
e o e-mail do Workspace chega (e chegou). O que o SPF ausente custava era
o resto: receptor que pesa SPF vê `none`, e **qualquer caminho que quebre
a assinatura DKIM** (encaminhamento, provedor transacional novo amanhã)
cai em `p=reject` — rejeição, não caixa de spam. Para um endereço que é
**canal legal do titular** (`juridico@`), silêncio é descumprimento.

Ficou parada não por falta de decisão — o valor estava definido e lido na
documentação oficial do Google (`v=spf1 include:_spf.google.com ~all`,
com o `~all` que eles recomendam) —, mas porque **o classificador de
permissões do harness recusava escrita de DNS**, e rotear a mesma escrita
por subagente seria contornar a guarda em vez de usá-la.

**O que passou a ser:** o dono liberou a permissão em 18/09/2026 e o
registro foi criado pela API da Cloudflare, na raiz da zona, `ttl: 1`
(automático).

Conferido, e não suposto:

- os cinco TXT que já existiam foram **lidos antes** da escrita, e o
  método foi `POST` (cria) e não `PUT` (substitui) — o TXT de
  verificação do Google que já morava na raiz continua lá, porque vários
  TXT convivem no mesmo nome;
- a resposta da API devolveu `success: true` com o conteúdo exato;
- **dois resolvedores independentes** (`dns.google` e
  `cloudflare-dns.com`) devolvem `v=spf1 include:_spf.google.com ~all`;
- **controle negativo:** `api.sancocore.com.br` não devolve SPF nenhum —
  o registro está na raiz, que é onde o remetente está, e não espalhado
  por subdomínio.

Antes de fixar o valor eu havia confirmado que **não existe outro
remetente para incluir**: não há biblioteca de envio de e-mail no `src/`,
e as notificações da Asaas ao comprador nascem desligadas
(`asaasService.buscarOuCriarCliente` manda `notificationDisabled`). Se um
provedor transacional entrar um dia, o `include` dele entra no MESMO
registro — dois `v=spf1` na mesma zona invalidam os dois.

### 🟡 Rotação do token de webhook não tem janela sem risco — DECLARADO 17/09
O receptor aceita **um** `ASAAS_WEBHOOK_TOKEN` por vez. Trocando
primeiro no Northflank, a Asaas entrega com o valor velho e leva 503;
trocando primeiro na Asaas, o mesmo pelo outro lado. Qualquer ordem
acumula falha, e 15 seguidas pausam a fila da conta (`CONSTRAINTS.md`
§2.3). Hoje o procedimento é "trocar nos dois lugares em sequência, em
tráfego baixo, e conferir a aba Webhook" (`RUNBOOK` §1.2).

Aceitar dois tokens durante a virada resolve, e é pouco código — mas é
código no caminho do dinheiro, e a troca para produção já vai rotacionar
esse token uma vez sob acompanhamento. Fica declarado, não construído às
pressas.

### 🟡 A chave de sandbox da Asaas apareceu na saída de um comando — 17/09
`northflank get service` imprime o `runtimeEnvironment` **com os
valores**. Rodei o comando para levantar o inventário de contas do
RUNBOOK, e com ele saíram a `ASAAS_API_KEY` de sandbox (a de homologação, pelo prefixo) e
o `ASAAS_WEBHOOK_TOKEN` de sandbox na saída da sessão.

Não é chave de produção e os dois valores serão substituídos no passo 4
da troca (`RUNBOOK` §6.2) — que é a rotação. Mas o registro fica, e o
aviso entrou no `RUNBOOK` §1.2 com o comando que lista **só os nomes**
das variáveis. A regra que eu já seguia para a chave de produção ("ela
não sai do contêiner") valia igual para esta, e eu não a apliquei ao
comando de inventário.


### 🟠 Assinatura encerrada pela Asaas só chega por conciliação, nunca por aviso — MEDIDO 16/09
Achado em 15/09/2026, auditando o caminho da assinatura. O
`CONSTRAINTS.md` §2.2 se declara "referência única" dos eventos
marcados no painel da Asaas — e **não menciona o grupo de assinaturas em
lugar nenhum**, nem como marcado nem como desmarcado de propósito. O
`classificarEvento` também não tem ramo para ele.

**Medido em 16/09** (`GET /v3/webhooks` rodado de dentro do container de
produção): dos **53 eventos configurados**, **zero** são `SUBSCRIPTION_*`.
Não era ambiguidade de documentação — a Asaas realmente nunca nos avisa
de nada que aconteça com uma assinatura. A suspeita estava certa.

O que mudou desde a declaração: a conciliação (§5.3) passou a reconferir
o estado da própria assinatura contra `GET /v3/subscriptions/{id}` (ver
a pendência seguinte). Então uma assinatura cancelada direto no painel
da Asaas, ou encerrada por ela depois de falhas de cobrança, **é**
detectada e corrigida no nosso banco — só que por **pull**, quando o
contratante concilia, e não por aviso na hora. O buraco encolheu de
"nunca chega" para "chega com o atraso da conciliação dele".

**Fechar** é marcar o grupo de assinaturas no painel e tratar os eventos
— e continua exigindo medir primeiro: ler o payload real de um antes de
escrever tratamento, que foi escrever contra payload imaginado que
causou os dois bugs de 15/09.

### 🟢 Sem reconciliação quando cancelar/pausar/retomar perde a confirmação — CORRIGIDO 16/09
**Corrigido no mesmo dia em que foi declarado.** A razão de ter ficado
declarado era não saber o formato de `GET /v3/subscriptions/{id}` pra
uma assinatura deletada — e a saída não foi adivinhar: a doc da Asaas
confirma os campos `deleted` (boolean), `status`
(`ACTIVE`/`EXPIRED`/`INACTIVE`) e `nextDueDate`, e **não** esclarece se
uma assinatura removida volta como objeto com `deleted: true` ou como
`404`. `consultarAssinaturaNaAsaas` (asaasService.js) trata os DOIS
casos, então funciona sem depender de eu ter acertado qual é — e o
`404` de propósito NÃO vira "cancelada" automática (404 também é id de
outra conta). `consultarAssinatura` chama isso e corrige o banco quando
diverge.

**Medido ao vivo em 16/09** (o mesmo `GET` rodado de dentro do container
de produção, contra `sub_qut6521d50496vkn`, cancelada naquele dia): a
Asaas usa o **primeiro** formato — `HTTP 200` com `deleted: true` e
`status: "INACTIVE"`. Duas consequências que a documentação não deixava
ver:

1. `INACTIVE` é o MESMO status de uma assinatura **pausada**. Quem olhar
   o status antes do `deleted` marca toda cancelada como `pausada` — por
   isso a ordem em `assinaturaAtualizada` é `deleted` primeiro, e é uma
   das regras travadas pelo autoteste de `cobrancaConsultaController.js`.
2. O `404` sobrou só para id de outra conta ou digitado errado — o que
   confirma a decisão de ele NÃO virar "cancelada" automática.

A mesma medição achou um **terceiro** dado que não estava sendo usado: a
resposta traz `cycle`, e quem cobra é a Asaas. `sub_qut6521d50496vkn`
estava `YEARLY` lá e `MONTHLY` aqui — rastro das assinaturas nascidas
antes da correção de 15/09. A correção na origem só valeu para as novas;
a conciliação agora corrige as velhas também. O texto original fica
abaixo, pro histórico.

<details>
<summary>como estava declarado</summary>
Achado em 16/09/2026, numa varredura focada em achados graves. `chamarAsaas`
tem teto (`CONSTRAINTS.md` §2.7.1) — mas se o timeout estourar DEPOIS de a
Asaas já ter processado o `DELETE`/`PUT` (só a resposta que não voltou a
tempo), `assinaturaController.cancelarAssinatura`/`pausarAssinatura`/
`retomarAssinatura` devolvem erro pro contratante e a linha seguinte
(`atualizarStatusAssinatura`) nunca roda: `assinaturas.status` no nosso
banco fica desatualizado — possivelmente pra sempre — enquanto a Asaas já
tem o outro estado.

`POST /consultar-assinatura` (§5.3) reconcilia a **última cobrança**
contra a Asaas (`statusAtualizado`, `cobrancaConsultaController.js`), mas
o `status` da própria assinatura (`ativa`/`pausada`/`cancelada`) vem
100% do banco local — nunca é reconferido contra
`GET /v3/subscriptions/{id}`. Não existe hoje nenhum caminho, nem manual,
pra detectar essa divergência depois do fato.

**Declarado, não corrigido às cegas**: a solução mais óbvia (consultar
`GET /v3/subscriptions/{id}` em `consultarAssinatura` e usar o status de
lá) exige saber exatamente como a Asaas representa uma assinatura
DELETADA nesse endpoint — campo `deleted: true`, mudança em `status`, ou
404 — e isso não está confirmado contra o payload real. É a mesma classe
de erro que já custou caro duas vezes aqui
(`docs/erros/2026-09-15-confiei-que-o-checkout-paid-traria-o-id-do-pagamento.md`,
`docs/erros/2026-09-15-ciclo-de-assinatura-nao-vinha-de-webhook-nenhum.md`):
escrever contra o formato imaginado. Fechar exige chamar
`GET /v3/subscriptions/{id}` de verdade contra uma assinatura cancelada
no sandbox (já existe uma: `sub_qut6521d50496vkn`, testemaster) e ler a
resposta antes de codificar o tratamento.
</details>

### 🟢 `assinaturas.proxima_cobranca` não tinha fonte confiável — CORRIGIDO 16/09
**A pergunta estava certa e a busca estava no lugar errado.** Procurei
`nextDueDate` em payload de webhook, onde ele de fato nunca aparece —
mas ele existe na consulta direta, `GET /v3/subscriptions/{id}`
(documentado pela Asaas junto de `deleted` e `status`, e **confirmado ao
vivo em 16/09**: a assinatura ativa do MostrAí devolveu `nextDueDate`
preenchido). A rota de
conciliação (§5.3) passou a ler de lá e devolver em `proximaCobranca`,
no mesmo ciclo em que ganhou a reconciliação de status. Continua podendo
vir `null` (assinatura encerrada, ou Asaas fora do ar — a conciliação
não falha por isso). O texto original fica abaixo, pro histórico.

<details>
<summary>como estava declarado</summary>
Achado em 15/09/2026, no mesmo ciclo que corrigiu `ciclo` (ver
`docs/erros/2026-09-15-ciclo-de-assinatura-nao-vinha-de-webhook-nenhum.md`).
Nenhum payload da Asaas medido traz `payment.nextDueDate`, e o
"nextDueDate" que o próprio checkout manda na criação é a data de HOJE
(a cobrança é imediata), não uma projeção da próxima — usá-lo pareceria
preciso sem ser, então fica `null` de propósito.

Fechar exige achar de onde a data real da próxima cobrança pode vir
(possivelmente só depois de confirmado o formato de um `PAYMENT_CREATED`
futuro da assinatura, hoje sem ramo em `classificarEvento`) — não é
um `?? algumCampo` a mais, é medir um payload que ainda não foi visto.
</details>

### 🟢 `returnUrl` não chega à página de status
O caminho de volta foi construído em 15/09/2026 e vale na tela do
checkout: quem paga ali ganha o botão "Voltar para {loja}" e a contagem
de 10 s (RN-15, `API.md` §3.1). A página `status.html` — onde aterrissa
quem fechou a aba e voltou pelo link permanente — **não** carrega o
`returnUrl`, então quem confirma o pagamento por lá continua sem o botão.

Não é furo de segurança nem regressão: é o mesmo estado de antes, e a
regra do destino já é do servidor. É trabalho de UX que ficou de fora
para manter a mudança revisável — fechar exige levar o parâmetro no link
permanente (`app.js`, `mostrarLinkPermanente`) e repetir a fiação em
`status.js`, contra a rota `/api/checkout/status`, que hoje nem recebe o
parâmetro.

### 🟢 Os dois últimos `?? 0` — FECHADOS 17/09
Eram o terceiro e o quarto lugar da família dos dois erros de total: a
linha de item do resumo (`R$ 0,00` para item sem preço) e a tela de
status (`formatarMoeda(dados.valorCobrado)` com `?? 0` por baixo). Os
dois passaram a mostrar travessão. O da tela de status era o mais
desconfortável dos quatro: é a tela que a pessoa abre DEPOIS de pagar, e
"R$ 0,00" ali diz a quem acabou de pagar que não pagou nada.

### 🟢 Métrica · janela por dia civil — CORRIGIDO 16/09
Era: `GET /api/admin/metricas?dias=N` contava as últimas N×24 h, sem
recorte por dia. Corrigido com janela por **dia civil de Brasília**
decidida no servidor (`src/utils/diaCivil.js`), e a aba Métricas
respondendo "Ontem" e "Hoje" por extenso.

**Fechar exigiu mais do que trocar a janela**, e isso é o que a entrada
antiga não previa: não existia coluna dizendo QUANDO a cobrança foi
confirmada. `criado_em` é a geração; `atualizado_em` muda por qualquer
motivo. Então "confirmadas ontem" era inrespondível por falta de dado,
não por falta de recorte — migration 0008 (`confirmado_em`).

Dois fatos medidos dentro do contêiner de produção no mesmo dia: o
processo roda em **UTC** (logo, data local do servidor erraria 3 h por
dia), e o **fuso nomeado funciona** (ICU completo na imagem alpine).
O autoteste de `diaCivil.js` fica vermelho se o segundo deixar de valer.

`docs/funcional.md` §9, RN-27 vizinha, `metricaService.js` com 26
checagens e quatro sabotagens.

### 🟡 Direitos · não existe ticket de atendimento com auto-resposta
O canal do titular e o de suporte são e-mail (`juridico@`, `suporte@`),
agora visíveis no rodapé das duas telas do comprador. O que não existe é
protocolo: quem escreve não recebe número nem confirmação automática, e
não há prazo contado em lugar nenhum. Enquanto o volume for o de hoje,
caixa de entrada resolve; vira problema no primeiro pedido que se perder.
Declarado em `docs/funcional.md` §8.

### 🟠 Estação 6 · o limite por IP não é guarda de força bruta
Medido em 11/09: doze requisições passaram por um teto de 10/min porque o
proxy de saída alternava entre três endereços. A `X-Checkout-Key` não tem
nenhuma outra guarda além do tamanho. Declarado em `CONSTRAINTS.md` §2.7;
contador por credencial está em `docs/proximas-versoes.md`, esperando
evidência de tentativa real no log de rejeição.

### 🟢 Piso de R$5 da Asaas e a regra do telefone — FECHADOS 17/09
Eram duas entradas da mesma família ("o checkout aceita entrada que a
Asaas depois rejeita, e quem descobre é o comprador no clique"), e as
duas foram fechadas por MEDIÇÃO de dentro do contêiner de produção.

**O piso é R$ 5,00 no valor cobrado, nos seis caminhos** — Pix, boleto,
cartão, "pergunte ao cliente", assinatura e a pop-up —, com controle
positivo em R$ 5,00 exato passando em todos (`API.md` §9.1). Agora as
duas rotas que abrem tela devolvem `bloqueio` com a frase pronta, e as
cinco que criam cobrança repetem o guarda. RN-28.

**A regra do telefone não era a que estava escrita aqui.** Esta entrada
dizia que a Asaas recusa "número de dígito repetido"; 24 combinações
medidas mostram que não — `11988888888` e `11911111111` passam. As
regras reais são DDD ≥ 11, celular começando em 9, e a parte depois do
DDD não ser um único dígito repetido (`API.md` §9.2). Escrever o
validador contra a frase errada teria recusado comprador legítimo no
caminho do dinheiro, que é pior que o bug original. RN-29.

### Prontidão operacional · decisão de 14/09 — adiar, com dois gates
O dono decidiu tratar os itens de prontidão que exigem correção/criação
como atualizações futuras, enquanto o checkout fica em sandbox. Aceito
para o estado atual (um operador, sem dinheiro real). **Mas dois não são
"quando der" — travam a troca para produção:**

- **Alerta externo de queda + fila de webhook pausada (Lei 8, item 2) —
  RESOLVIDO POR DECISÃO DO DONO, 17/09.** O canal de alerta **é o e-mail
  de falha da Asaas**: sempre que uma entrega de webhook falha, a Asaas
  avisa por e-mail, e o dono recebe. Ele já recebeu um desses — apontando
  a URL antiga do Render, que não é mais usada —, o que é a evidência de
  que o canal funciona de verdade e chega nele.

  **A ressalva, corrigida pelo dono no mesmo dia** — eu havia escrito que
  o alerta "só dispara quando existe evento de pagamento", e isso é
  falso. O e-mail que ele recebeu veio de uma mudança de **situação da
  conta** (o registro passando de PJ para PF), sem pagamento nenhum no
  meio: o grupo "Situação da conta" tem 18 eventos marcados (§2.2), e
  eles disparam sozinhos quando algo muda na conta.

  O que fica de ressalva verdadeira é mais estreito: o e-mail depende de
  **algum evento acontecer**. Silêncio total — app fora do ar sem
  pagamento e sem mexida na conta — não gera aviso. Aceito como está: um
  monitor externo seria detecção mais cedo, não detecção onde hoje não
  existe nenhuma.
- **Backup com restauração testada (Lei 6) — metade feita, metade virou
  versão futura.** A restauração foi ENSAIADA em 17/09
  (`npm run ensaio-restauracao`, RTO 1 s, zero divergência). A cópia
  periódica fora do provedor virou atualização futura por decisão do
  dono no mesmo dia: **a Asaas é a cópia**, porque todo dado de cobrança
  e assinatura que importa existe lá também. Registrado em
  `docs/proximas-versoes.md` com o que essa escolha não cobre.

**Alerta de orçamento** nas contas pagas virou atualização futura por
decisão do dono (17/09) — `docs/proximas-versoes.md`. Do que estava
adiado aqui, **o desempenho saiu da lista no mesmo dia**: foi medido, e a
medição achou um defeito real (entrada logo abaixo). Continua adiável o
teste da segunda pessoa com o RUNBOOK, que depende de existir uma
segunda pessoa.

### 🟢 Prontidão · e-mail do titular/suporte — CONFERIDO, funciona
Investigado em 14/09. O `dig`/DoH da sessão de nuvem não resolveu MX
(proxy do sandbox bloqueia UDP 53 e a DoH), então a medição daqui era
inconclusiva — não "sem MX". **O dono confirmou:** o MX entrega em
`admin@sancocore.com.br`, e `juridico@` e `suporte@` são alias dele. O
canal do titular/suporte recebe. O checkout não envia e-mail ao
comprador (§1.9), então SPF/DKIM/DMARC de envio seguem N/A. Nada a
fazer; fica a lição de não afirmar DNS a partir do resolver do sandbox.

### ⚪ Opção (não bloqueia) · pôr a API atrás do proxy do Cloudflare
`api.sancocore.com.br` é DNS-only (nuvem cinza): resolve direto para o
Northflank, sem o Cloudflare no caminho (resposta sem `cf-ray`). Logo, o
`…code.run` e o domínio são a mesma porta pública, e a API é protegida
só pela auth de aplicação — que está sólida. **Se** um dia se quiser
WAF, limite de borda e fechar o endereço direto, o caminho é ligar o
proxy laranja em `api.sancocore.com.br` (com SSL Full (strict) e o
certificado da origem conferido) e então um segredo injetado por
Transform Rule volta a fazer sentido. Não feito, é decisão de infra do
dono. O middleware que dependia disso foi revertido em 14/09
(`docs/erros/2026-09-14-origem-direta-alcancavel-por-fora.md`).

### 🟢 SSRF residual do pull — FECHADO 17/09
Era: a entrada estava fechada (`apiBaseUrl` e `webhookUrl` exigem https e
host público, RN-14), mas a RESPOSTA do contratante não. O `fetch` seguia
redirect sozinho — um contratante malicioso ou comprometido responderia
`302` para `169.254.169.254` e o checkout buscaria a credencial da nuvem,
sem que a checagem de cadastro visse nada — e `resposta.json()` lia o
corpo inteiro, sem teto, numa instância de 512 MiB.

Fechado em `src/utils/puxarDoContratante.js`: redirect revalidado a cada
salto, **só mesma origem**, no máximo 3, e corpo com teto de 1 MiB
contado no fluxo (o `Content-Length` só serve para recusar cedo, nunca
para deixar passar). A regra de mesma origem não é só anti-SSRF: a
requisição leva a `X-Checkout-Key` do contratante, que autoriza consulta
e estorno — seguir o `Location` para outra origem entregaria essa chave a
quem respondeu. RN-30, `API.md` §9.0, 31 checagens exercitadas contra um
servidor de contratante malicioso de verdade.

A entrada antiga adiava isto para "quando houver mais de um contratante
real". A troca para produção chega antes, e o vetor não depende de
quantos contratantes existem — depende de um só ser comprometido.

### 🟡 Latência do painel · o piso é o Supabase, não o nosso código
Medido em 13/09/2026 **do navegador do operador** (não de container na
nuvem — o ambiente do teste faz parte do teste):

| o que | tempo |
|---|---|
| rota sem banco (`/api/admin/sessao` sem token) | **20-29 ms** |
| rota 404 | 18-21 ms |
| rota com uma consulta (`/api/saude`) | 70-295 ms, mediana ~90 |

Rede e aplicação estão rápidas; **cada ida ao Supabase custa 50-270 ms** e
é barulhenta. Não é geografia: backend em Osasco e o projeto
`San_Checkout` em `sa-east-1` (São Paulo), confirmado na API do Supabase.
Não é índice faltando: o linter só acusa 5 índices **não usados** (banco
vazio), nenhuma consulta lenta. A variação bate com compute compartilhado
do plano gratuito, e o acesso é por PostgREST sobre HTTPS, não conexão
direta ao Postgres.

O código parou de **multiplicar** esse número (chamadas em paralelo,
mutação sem rebuscar a lista — 13/09). Baixar o piso em si é decisão de
custo: plano pago do Supabase dá compute dedicado. **Não fazer nada é
aceitável** enquanto o painel é de um operador só; vira problema se o
volume crescer.

### 🟢 Lei 8 · captura de exceção com contexto — FEITO 16/09
A Lei 8 pede "captura de erro com contexto da requisição (Sentry ou
equivalente)". Feito **sem depender de conta em serviço externo**:
`erros` (migration 0007) + `erroService.js`, exposto na aba **Erros** do
painel. Todo 5xx vira linha com contexto, rota (padrão, nunca a URL),
método, status, tipo, código e os quadros de pilha do nosso `src/`.

Agrega por impressão digital em vez de gravar uma linha por ocorrência —
sem isso, qualquer rota pública que devolvesse 500 seria escrita
ilimitada no banco para quem só descobriu a URL. `CONSTRAINTS.md`
§2.5.1, RN-27, `docs/inventario-de-dados.md` §7.2.

**Falta a evidência que fecha o item da prontidão:** forçar uma exceção
em produção e vê-la na aba. Entra na primeira rodada depois do deploy.

### 🟢 Lei 8 · alerta de queda — FECHADO 17/09, por decisão do dono
A metade de código entrou em 14/09: `/api/saude` devolve `503`/
`degradado` quando o banco não responde (antes era `200 ok` mesmo caído),
o que deixa qualquer monitor por HTTP alertar. A metade de LIGAÇÃO estava
pendente — a entrada antiga pedia integração Slack/Discord no Northflank
mais um Cron Job batendo no `/api/saude`.

**O dono fechou por outro caminho em 17/09: o canal é o e-mail de falha
de webhook da Asaas.** Ele recebe esse e-mail hoje (recebeu um apontando
a URL velha do Render), então o canal está provado ponta a ponta sem
nada para configurar — e ele cobre também a fila pausada, que a entrada
antiga tratava como item separado e adiado.

**A evidência, e o que ela prova de verdade.** O e-mail que chegou foi
disparado pela mudança de registro da conta de **PJ para PF** — a
entrega foi tentada na URL velha do Render, falhou, e a Asaas avisou.
Isso prova duas coisas de uma vez: o canal chega no celular do dono, e
ele **não depende de tráfego de pagamento** — o grupo "Situação da
conta" (18 eventos marcados, §2.2) dispara sozinho.

**A ressalva verdadeira, mais estreita do que a que eu escrevi
primeiro:** o aviso depende de *algum* evento acontecer. Silêncio total
— nada de pagamento e nada mudando na conta — não gera aviso. Não é o
mesmo que um monitor batendo de minuto em minuto; é o que existe,
funciona, e chega em quem opera.

**E um efeito colateral que vale registrar:** a penalidade veio porque a
URL velha do Render ainda estava configurada no painel da Asaas. Isso é
a mesma classe do "identificador preso ao ambiente" do `API.md` §11.1 —
configuração de webhook que sobrevive a uma troca de hospedagem gera
falha silenciosa até alguém ler o e-mail. Na troca para produção
(`RUNBOOK` §6.2), desativar o webhook antigo é passo, não faxina
posterior.

### Lei 8 · eventos que chegam e só entram no log
`PAYMENT_APPROVED_BY_RISK_ANALYSIS`, os três de divergência de split e os
grupos de transferência e saldo estão marcados no painel da Asaas e caem
no ramo de não mapeado. É desenho, não descuido: a aba Webhook os mostra,
e o primeiro payload real decide o tratamento. Entrada em
`docs/proximas-versoes.md`.

### 🟢 Lei 0 · a skill `revisar` rodou — 11 ciclos, 17/09
Esta entrada era um TÍTULO SEM CORPO: dizia que a skill nunca havia
rodado e não dizia mais nada. Rodou em 17/09, lida na fonte (o plugin
não carrega nesta sessão — `ListPlugins` vazio —, então o repositório
`Plugin_san-co` foi clonado e a skill lida de lá, como o `CLAUDE.md`
manda).

**Onze ciclos completos**, cada um com as quatro varreduras (correção,
segurança, simplicidade, legibilidade), parando no primeiro ciclo limpo
— que é o critério da skill, não um número de voltas. O que cada volta
achou:

| ciclo | achados |
|---|---|
| 1 | expurgo lendo sem paginação (OOM e truncamento silencioso); corte de 29/02 transbordando e apagando um dia cedo; bloco duplicado no `server.js`; import duplo num teste |
| 2 | **`documento` eram duas chaves para a mesma pessoa** — assinatura incancelável (RN-32); laço de paginação sem freio; contador de checagens chumbado |
| 3 | `adminController` com cópia própria da normalização; contrato do webhook não dizia que o documento sai em dígitos |
| 4 | comentário repetido literal em 6 lugares; script de expurgo cuspindo pilha para documento mal digitado |
| 5 | **o piso da Asaas é POR PARCELA** e eu havia medido só com uma (RN-28 ampliada); oito autotestes com contador chumbado, três deles mentindo |
| 6 | comentário do contador repetido em 10 arquivos |
| 7 | a tela oferecia 12x num pedido que só cabe 5x; dois comentários falsos no `index.html`; número errado em 5 documentos |
| 8 | o teto de 12 parcelas morando em três lugares |
| 9 | a terceira cópia do teto (o `<select>`) podia divergir calada |
| 10 | terceiro comentário falso; último `?? 0` de dinheiro no front |
| 11 | **limpo** — o alarme do gitleaks foi investigado e é artefato de branch local nunca empurrada (conferido simulando o checkout do CI: 57 commits, zero vazamento) |

**A honestidade que a skill pede:** achado apareceu em dez das onze
voltas, e o teto de escalada dela manda dizer isso. Mas o padrão não é o
que aquele teto descreve — não foi a MESMA área devolvendo achado sem
parar, foi um código que nunca tinha passado por revisão nenhuma
devolvendo dívida acumulada em áreas diferentes. Os dois achados graves
(ciclos 2 e 5) eram bugs PRÉ-EXISTENTES no caminho do dinheiro, não
defeitos do desenho novo. O desenho aguentou as onze voltas.

**SEGUNDA RODADA no mesmo dia, a pedido do dono** — porque o que foi
escrito durante os ciclos 6 a 11 e depois deles (a suíte de rotas, o
teste da `cause`, os estados novos da acessibilidade, as correções de
documento) nunca tinha passado por ciclo nenhum. Nove voltas, parando
limpa. O que ela achou:

| ciclo | achados |
|---|---|
| 1 | uma assertiva `ok(true, …)` que NÃO PODE FALHAR, escrita por mim como preenchimento; dublês copiando à mão a mensagem do piso e o `maxParcelas` |
| 2 | controle positivo fraco: exigia "achou algum teto" em vez do número exato, então perder dois blocos passaria calado; a tabela de skills precisava se declarar índice, não regra |
| 3 | o `2.49` do teste de fronteira é preso à tabela de taxa e não avisava; expressão repetida no ponto fixo |
| 4 | **o ponto fixo podia devolver `parcelas` de uma faixa com a `taxa` de outra** ao sair pelo teto de voltas; o comentário do teto era chute meu — duas vezes; a varredura de propriedade usava 14 bases escolhidas à mão e não pegava nenhum dos 1.260 casos que uma volta quebra |
| 5 | a varredura da válvula de teste olhava só `src/controllers/`, quando a função pode ser chamada de qualquer lugar do `src/` |
| 6 | três suítes com cópia própria do andador de diretório — e a cópia nova **não descia subdiretório**, então aprovava o que não olhava |
| 7 | só um dos três caminhos de saída tinha guarda de execução para o `signal`, e é justamente o que recebe de fora |
| 8 | o `CLAUDE.md` mentia a contagem de suítes **pela terceira vez no dia**; ferramenta de uso manual em `tests/` tratada como suíte esquecida; cabeçalho do mock apontando para pasta que nunca existiu |
| 9 | **limpo** |

O achado do ciclo 4 é o que justifica a rodada inteira: para decidir o
teto de voltas do ponto fixo eu varri cada centavo de R$ 0,01 a
R$ 2.000,00 × 12 parcelas × isento e não isento, quatro vezes (4,8
milhões de casos por teto). Uma volta erra em 1.260 casos; duas acertam
mas só pela rede de segurança; três convergem sozinhas; quatro não muda
nada. O comentário que estava lá dizia "folga" e depois "o exato
necessário" — os dois errados, os dois meus.

E duas coisas que só a sabotagem mostrou: a bandeira de convergência era
sempre `true` (logo, não verificava nada) e a rede de segurança era
inalcançável — as duas viraram testáveis expondo o teto de voltas como
parâmetro, com varredura garantindo que nenhum chamador de produção o
usa.

O ciclo 8 fechou o problema que eu vinha tratando à mão: a contagem de
suítes no `CLAUDE.md` errou três vezes em um dia. Agora existe
`tests/o-que-os-documentos-afirmam.js`, que confere contra a realidade o
que os documentos AFIRMAM em número — contagem de suítes, tabela de
skills, e se cada caminho citado existe.

**`seguranca-san` rodou junto**, e acrescentou duas coisas: travou que a
`cause` do erro (que passou a carregar texto do contratante) nunca entra
no diagnóstico, e escreveu o teste da **lição nº 23** — a lista de rotas
limitadas conferida contra a lista de rotas montadas, que vinha sendo
feita a olho: 33 rotas, 17 prefixos, 5 sabotagens pegas. A primeira
versão dessa varredura acusou quatro rotas de Pix/Boleto que estão
CERTAS (montam o limitador por rota), e foi a varredura que se
corrigiu — guarda que acusa o que está certo é desligado na primeira vez
que atrapalha.

**Um achado fica declarado e NÃO corrigido, de propósito:** o import de
`randomBytes` no `adminController.js` está morto, e já estava antes desta
mudança. A skill manda não refatorar código vizinho que não faz parte do
problema — misturar os dois trava o merge.


### 🟢 Lei 0 · cobertura de teste nas rotas HTTP — FECHADO 17/09
Era: nenhuma suíte subia o Express, e o roteiro de login por token
exercitado à mão em 12/09 nunca virou teste. Virou —
`tests/rotas-http-respondem-como-prometido.js`, 29 checagens contra a
pilha montada de verdade (`src/server.js`), não contra um Express
remontado pelo teste: login certo, senha errada e usuário errado com a
MESMA mensagem, token inventado, token adulterado num caractere, token
assinado com outro hash de senha, o teto de 5/min, o 404 sem pilha, e os
cabeçalhos do helmet.

Uma sabotagem desta suíte passou, e o que ela revelou foi um comentário
falso no `server.js` — a afirmação de que a ordem de registro dos
limitadores importa. Medido: não importa, o `app.use` roda todos os que
casam. Comentário corrigido; o teste não passou a exigir uma ordem que
não existe.

### 🟢 Lei 10 · a rotina de expurgo de dado pessoal — ESCRITA 17/09
Era: retenção de 5 anos declarada, caminho de exclusão conferido contra a
modelagem, e nenhuma rotina — ou seja, prazo como intenção, não prática.
`src/services/expurgoService.js`, no ciclo de 24 h, com `npm run expurgo`
para o operador ver antes (simula por padrão) e uma função separada para
o pedido do titular (LGPD art. 18) que respeita a guarda fiscal e diz
quantas linhas ficaram retidas em vez de responder "feito".

Decide por **lista branca do que fica**: lista negra falha aberta, e
falhar aberta aqui é uma coluna pessoal criada em 2027 sobrevivendo para
sempre. Conferida em simulação contra o banco de produção, com controle
positivo. RN-31, `docs/inventario-de-dados.md` §6.

**A validação jurídica continua aberta e é da Estação 7** — os 5 anos são
a escolha mais defensável sem advogado, não um parecer.

### 🟢 Migration 0004 — search_path e as colunas de `cobrancas` — FEITO 17/09
A **correção de `search_path`** das duas funções da 0002 que o linter
acusava foi aplicada em 14/09 (`supabase/migrations/0004_search_path_funcoes.sql`,
`alter function ... set search_path = public`) — o advisor de segurança
não acusa mais o WARN, só o INFO de RLS-sem-policy, que é o default-deny
intencional (backend usa service_key; anon/publishable leem zero linha,
conferido).

As **duas colunas de `cobrancas`** entraram em 17/09, na migration
**0009** — `ambiente` (conjunto fechado `sandbox`/`producao`, por check
constraint) e `e_teste` (de mão única, travada por gatilho no banco, não
por código de aplicação). O gatilho da 0009 foi a troca para produção: a
métrica de sucesso contaria o pagamento de teste do dono como resultado
de negócio no primeiro dia de dinheiro real. A regra é a RN-33
(`docs/funcional.md`), e o filtro está em `metricaService`, que relata o
que excluiu em vez de excluir calado.

Aplicada e conferida no banco de produção no mesmo dia: colunas com
`not null` e default, a constraint recusando `ambiente = 'homologacao'`,
o gatilho recusando real→teste com a mensagem escrita, e as 10 cobranças
existentes corretamente em `sandbox`/`false`. As duas regras foram
provadas ao vivo com uma cobrança descartável, que foi apagada depois.

Uma ressalva que a própria migration não diz: o comentário dela chama
`idx_cobrancas_metrica_real` de "índice sobre o que a consulta de fato
lê", e isso não é verdade hoje — o corte de negócio acontece em JS,
porque o relatório precisa contar o que excluiu. O índice só passa a
valer se o corte descer para o SQL. A migration fica como está (§2.1,
imutável); a verdade está no `CONSTRAINTS.md` §2.9.

**Ainda desenhada e não escrita:** `desativado_em` em contratantes. Ela
não tem gatilho hoje — entra com o modo de teste por contratante
(`docs/proximas-versoes.md`), se ele vier. Note que a 0004 previa
`e_teste` em **contratantes**, e a 0009 o pôs em **cobranças**: a
marcação é da cobrança, porque o contratante real pode ter uma linha de
teste e o contratante de teste pode ser arquivado sem levar o histórico
embora.

### Quando ligar o proxy laranja do Cloudflare ou outro salto
O `app.set('trust proxy', 1)` confia em **um** proxy. Verificado em
12/09 que ele continua correto com o CDN do Northflank — o limitador
trava no 11º disparo, do IP real. Ligando o proxy do Cloudflare por cima,
a contagem muda e o limitador volta a ser risco: ou todo mundo cai no
mesmo balde, ou o IP vira forjável. Ajustar junto, e o SSL/TLS do
Cloudflare em **Full (strict)**, nunca Flexible.

### Ao trocar o Northflank para produção
Três variáveis: `ASAAS_AMBIENTE` para `producao`, `ASAAS_API_KEY` e
`ASAAS_WEBHOOK_TOKEN` para os de produção. Mais: apagar o webhook do
painel sandbox da Asaas (ele acumularia 401 e pausaria a fila do
sandbox) e limpar as cobranças de teste antes de entrar dinheiro real.
`public/js/utils/api.js` e o `connect-src` do `_headers` já apontam para
`api.sancocore.com.br` desde 12/09 — trocar de host é trocar o CNAME, não
mexer no código.

### 🟢 Acessibilidade WCAG 2.2 AA — VERIFICADO 17/09
Obrigação legal (LBI art. 63 + Decreto 9.405/2018, valendo inclusive
para ME/EPP/MEI), cobrada pela skill `legal` na estação 6. Verificado com
axe-core num Chromium de verdade: `npm run acessibilidade`.

Cinco violações reais achadas e corrigidas — quatro de contraste
(`--text-muted` dava 2,54:1 contra o mínimo de 4,5:1) e 19 SVGs
decorativos sem `aria-hidden`, este último fora do alcance do axe.
A causa raiz do contraste era duplicação: as duas páginas legais
carregavam **cópia inline da paleta**, então não viram a correção do
token central. `docs/funcional.md` §11 tem a tabela e o método.

**O que fica declarado, não fechado:**

- **O verificador não roda no CI.** A lei sugere ("verificador
  automático no CI resolve a maior parte") e faltam duas coisas que só o
  dono faz: acrescentar o passo em `.github/workflows/ci.yml` e garantir
  Chromium no runner. Comando pronto abaixo. Hoje roda à mão, e "à mão"
  significa que uma regressão de contraste passa até alguém lembrar.

  ```yaml
        - name: Acessibilidade (axe-core, WCAG 2.2 AA)
          run: |
            npx playwright install --with-deps chromium
            CHROMIUM_EXECUTAVEL="$(npx playwright print-api-json 2>/dev/null >/dev/null; echo '')" npm run acessibilidade
  ```
  Sem `CHROMIUM_EXECUTAVEL` definida o script usa
  `/opt/pw-browsers/chromium`; no runner do GitHub o caminho é outro, e é
  por isso que a variável existe. Em runner com o browser instalado pelo
  próprio Playwright, basta deixá-la vazia e trocar a linha do `run`
  por `npm run acessibilidade` depois do `playwright install`.

- **Estados que dependem da Asaas** — QR gerado, boleto emitido, erro
  devolvido pelo servidor — não são auditados: exigem cobrança viva.
  Ficam para a rodada ao vivo no sandbox.

- **Ordem de foco** conferida só quanto a indicador e nome em cada
  parada, não quanto à sequência seguir a leitura da tela.


### 🟢 Subconta bloqueada pela conta PF — VIROU DECISÃO 17/09
Deixou de ser pendência: o dono decidiu **operar na conta como ela está
(pessoa física)**, sem subconta e sem split, e tratar a conversão do
registro como atualização futura.

O que ficou: exceção aceita em `CONSTRAINTS.md` §3 (com a consequência
escrita), entrada em `docs/proximas-versoes.md`, e a medição que provou a
causa em `CONSTRAINTS.md` §2.5.3 +
`docs/erros/2026-09-17-diagnostico-de-subconta-lia-o-endpoint-errado.md`.
