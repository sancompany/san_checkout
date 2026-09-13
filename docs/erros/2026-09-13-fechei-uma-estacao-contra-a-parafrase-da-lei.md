# Fechei uma estação contra a paráfrase da lei, não contra a lei

**Quando:** 13/09/2026. A Estação 4 foi declarada fechada de manhã; o
plugin `san-co` só foi lido na fonte no fim do dia.
**Onde:** `docs/funcional.md`, e no `CLAUDE.md` que disse "fechada".

## O que aconteceu

O `CLAUDE.md` diz que este projeto segue as leis do plugin `san-co`. O
plugin **não estava instalado** nesta sessão: `ListPlugins` vazio, bucket
de plugins sincronizados vazio, nenhuma das nove skills carregada.

Trabalhei o dia inteiro citando "a lei pede X" — e o que eu tinha era a
citação que já estava escrita nos documentos deste repositório. Paráfrase
de paráfrase. Fechei a Estação 4 assim.

Quando o dono mandou conferir o plugin, clonei o repositório dele e li
`references/definicao-funcional.md`. **Seis das dez seções divergiam.**

## O que estava errado, item por item

| seção | o que a lei pede | o que eu tinha escrito |
|---|---|---|
| 3 Telas | nome · URL · quem acessa · o que mostra · **o que dá para fazer** · **para onde leva** | nome, arquivo, quem vê, protegida por |
| 4 Estados | os seis do modelo por tela — vazio, carregando, erro, sucesso, sem permissão, lista longa — e "não se aplica" **escrito** onde não se aplica | duas telas com estados próprios; as outras cinco sem nenhum |
| 5 Regras | **numeradas**, com o que vale, a consequência e **quem vê a violação** | parágrafos em negrito, sem número e quase sempre sem "quem vê" |
| 8 Direitos | cada direito é **tela ou fluxo das seções 2 a 7**, não uma seção à parte | tabela isolada descrevendo direitos |
| 9 Eventos | convenção `categoria:objeto_acao`, verbo no presente, propriedades `objeto_adjetivo`; para cada um: onde é emitido, **quais propriedades** e **qual pergunta responde** | o vocabulário do webhook (`cobranca_confirmada`), só com onde fica registrado |
| 10 Fora desta versão | **uma linha** apontando para `CONSTRAINTS.md` e `proximas-versoes.md`, sem repetir | a lista inteira repetida |

Nada disso é detalhe de forma. A convenção de nome de evento existe para
ser decidida **antes** da instrumentação — decidir depois é renomear
evento já gravado. "Quem vê a violação" é o que transforma regra em
comportamento verificável. E "não se aplica" escrito é o que distingue
*pensei e não precisa* de *esqueci*.

## A causa raiz

**Aceitei documentação de segunda mão como fonte, num projeto cuja
primeira linha manda ler a fonte.** O `CLAUDE.md` aponta para o plugin; o
plugin não estava lá; eu segui mesmo assim, porque os documentos do
repositório citavam a lei com confiança suficiente para parecer bastar.

O agravante é a direção do erro: paráfrase escrita por quem entendeu a
lei tende a guardar o que **aquele** projeto usou dela, e a perder o
resto. Foi exatamente o que aconteceu — o que sobreviveu na citação foi o
que já estava feito.

É parente do erro de 12/09 (`o-cloudflare-access-sumiu-da-frente-do-admin`):
lá o documento descrevia uma proteção que a web não tinha; aqui o
documento descrevia uma lei que eu não tinha lido.

## O que fica

- **Ferramenta que a sessão diz seguir e não está carregada é bloqueio,
  não detalhe.** A primeira ação, ao ver `ListPlugins` vazio num projeto
  que cita plugin, é dizer isso ao dono — antes de fechar qualquer
  estação.
- **Citação não é fonte.** Documento do projeto que resume uma regra
  externa serve de índice; fechar contra ele é fechar contra o resumo de
  quem já tinha decidido o que fazer.
- **Fechamento feito com a fonte errada não vale, mesmo que o conteúdo
  esteja bom.** A Estação 4 tinha conteúdo defensável e forma errada em
  seis seções; reabrir e refazer custou menos que uma estação 5 inteira
  construída sobre definição incompleta.
- Estado depois da correção: `.claude/settings.json` declara o
  marketplace, e o repositório do plugin fica clonado em
  `/home/user/sancompany/plugin_san-co` para leitura na sessão atual.
