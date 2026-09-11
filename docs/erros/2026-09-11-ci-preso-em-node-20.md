# CI falha porque fica preso em Node 20, e a dependência já exige 22+

**Sintoma.** Ao conferir a Estação 3 (Fundação) — "CI verde num push
real" — o job `testes` do último push estava em **Failure**, com 1 de 4
suítes quebrada (`src/services/pedidoService.js`) e a mensagem
`Error: Node.js detected but native WebSocket not found. Suggested
solution: Ensure you are running Node.js 22+`.

**Causa raiz.** `package.json` fixa `"@supabase/supabase-js": "^2.45.0"`
— faixa aberta, sem trava de versão exata — e a versão instalada já
exige WebSocket nativo, presente a partir do Node 22. O
`.github/workflows/ci.yml` fixava `node-version: '20'`. A dependência
avançou, o CI não.

A produção não caiu com o mesmo erro por acidente: o Render nunca teve
`engines.node` declarado, então escolheu sozinho uma versão mais nova por
padrão, que por sorte já tem WebSocket nativo. O CI é que ficou preso
porque `'20'` era escolha explícita, não um padrão que acompanha o tempo.

**Correção.** Duas partes. Aditiva, aplicada na hora: `package.json`
ganhou `"engines": { "node": ">=22" }`, declarando a versão que o projeto
já precisava em vez de depender do padrão de cada plataforma — de quebra,
o Render passa a lê-la de propósito e não por acaso. Estrutural:
`.github/workflows/` é protegido contra escrita remota, então a troca de
`node-version: '20'` por `'22'` foi entregue pronta para colar e ficou
como pendência bloqueando a esteira até o dono aplicar.

**Guarda.** `engines` no `package.json` é a trava: ela faz dev local, CI
e Render andarem pela mesma régua, e um `npm ci` em runtime abaixo do
declarado passa a avisar em vez de quebrar só na suíte. A confirmação foi
ao vivo, não por dedução — run #5 (`atualização ci`) **Success**, 4
suítes passando em 15s. O aviso restante no log ("Node.js 20 is
deprecated... forced to run on Node.js 24") é sobre o runtime que o
próprio GitHub usa para executar as actions (`checkout@v4`,
`setup-node@v4`), não sobre o Node que roda os testes — causa diferente,
não bloqueia nada.

**Como evitar na origem.** Faixa de versão aberta (`^2.45.0`) numa
dependência cujo runtime é fixado separadamente em outro lugar (CI,
produção) é o padrão exato deste erro: o pacote anda, o ambiente fixo
fica para trás em silêncio até quebrar. Onde o runtime for fixado por
escolha explícita, declarar a exigência no manifesto do projeto — senão
o único lugar que aponta a versão certa é aquele que quebrou.

**Ecossistema:** sim — a combinação "dependência com faixa aberta" mais
"runtime fixado à mão no CI" existe em qualquer stack com gerenciador de
pacotes, e o sintoma aparece sempre no CI antes de aparecer em produção.

> **Nota sobre SHAs:** a reescrita de histórico da Estação 4 (ver
> `2026-09-11-filter-repo-apagou-trabalho-nao-commitado.md`) trocou todos
> os identificadores de commit do repositório. Os que apareciam aqui
> (`11498e5`, `4c01cda`) não existem mais.
