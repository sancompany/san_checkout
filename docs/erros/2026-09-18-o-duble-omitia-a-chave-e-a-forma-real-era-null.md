# O dublê omitia a chave, e a forma real era `null` — que `Number()` lê como zero

**Quando:** 18/09/2026, no ciclo de revisão da própria mudança que
passou a reconciliar `valor` contra a Asaas (RN-34, decisão do dono do
mesmo dia).
**Onde:** `src/controllers/cobrancaConsultaController.js`,
`assinaturaAtualizada` — a guarda que decide se um valor vindo de fora é
dinheiro utilizável.

## O que aconteceu

A reconciliação nova compara o preço que a Asaas cobra com o que está no
nosso banco, corrige o nosso e denuncia a divergência ao contratante. A
guarda que eu escrevi para não comparar contra lixo foi esta:

```js
const utilizavel = (v) => Number.isFinite(Number(v));
```

`Number.isFinite(Number(null))` é **`true`**, porque `Number(null)` é
`0`. E `consultarAssinaturaNaAsaas` devolve o campo assim:

```js
valor: corpo?.value ?? null
```

Ou seja: `null` **explícito** sempre que a resposta da Asaas não traz
`value`. Juntando as duas linhas, uma assinatura nessa situação seria
lida como **R$ 0,00 na Asaas**, divergente do nosso registro — e a
reconciliação então (1) gravaria zero em `assinaturas.valor`, (2)
devolveria `valor: 0` ao contratante, no campo que o `API.md` §5.3
acabara de ganhar permissão para tratar como verdade, e (3) denunciaria
uma divergência que não existia, mandando o contratante avisar o
assinante de uma mudança de preço inventada.

Não havia sintoma: nenhum erro, nenhum log, um número plausível.

## Por que o autoteste não pegou

Porque o dublê não tinha a forma real. Eu escrevi o caso "Asaas sem
`value`" assim:

```js
{ status: 'ACTIVE', encerrada: false, ciclo: 'MONTHLY' }   // chave OMITIDA
```

Chave omitida é `undefined`, e `Number(undefined)` é `NaN`, que a guarda
recusa corretamente. O teste exercitava o único caminho em que o código
errado acertava. **O dublê era mais limpo que a realidade** — e o que o
código vê na produção é `null`, não ausência.

É literalmente a mesma lição do dublê de pedido com o formato de item
errado (17/09): naquele, a linha de item nunca havia sido exercitada
porque o dublê tinha um formato que o sistema não produz.

## A regra que fica

**O dublê copia a forma que a função REAL devolve, não uma forma
plausível.** Onde há um `?? null` no caminho, o caso de teste manda
`null`; onde o driver pode devolver `numeric` como texto, manda texto.
A conferência é mecânica: ler a linha que produz o dado e espelhá-la.

E a guarda de dinheiro passou a checar o **tipo antes do valor**, em vez
de converter primeiro:

```js
function dinheiroOuNulo(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && valor.trim() !== '' && Number.isFinite(Number(valor))) {
    return Number(valor);
  }
  return null;
}
```

`Number(x)` coage `null`, `''`, `[]` e `false` para `0`. Em caminho de
dinheiro, **coerção é a armadilha, não a conveniência**: ela transforma
"não sei" em "zero", que é um número que ninguém questiona.

O teste agora roda os dois formatos em laço — chave omitida **e** `null`
explícito, este rotulado "a forma REAL" no código —, exige
`valor === 30`, exige explicitamente `valor !== 0`, e exige que nada
tenha sido gravado e nada denunciado. A sabotagem que devolve
`Number.isFinite(Number(v))` reprova com a mensagem certa
("mantém o nosso valor — veio 0").

É a terceira vez que este projeto paga por **ausência lida como zero**:
a coluna que o `select` não trazia (17/09), o placeholder `0,00` que
sobrevivia ao erro na tela, e agora este. A família é sempre a mesma:
o caminho de dinheiro não erra com estrondo, erra com um número
plausível.

**Ecossistema:** sim. Vale para todo projeto que leia número vindo de
terceiro ou de banco — e a regra do dublê vale para qualquer teste com
dependência injetada.

---

## Apêndice do mesmo dia: o sha que envelhece porque o documento é publicado

Ainda em 18/09, ao registrar o estado no ar, escrevi no `CLAUDE.md`
"main = `3ec6454` e **é** o `deployedSHA`". Mesclei o PR seguinte — só
documento — e a frase ficou falsa em três minutos, porque o commit que
atualiza a linha muda o número que a linha afirma. Corrigi nomeando os
dois shas, e **a correção teve o mesmo defeito**: o PR que a levou ao ar
mudou o servido de novo.

A regra, na terceira tentativa: **documento publicado não afirma o sha
que está publicado.** A linha nomeia o último commit de **código** (que
só muda quando código muda) e manda no comando que responde o resto
(`RUNBOOK` §3). É a mesma família do "N suítes" escrito em prosa: número
que envelhece sozinho não mora em texto — mora em quem sabe medi-lo.

**Ecossistema:** sim, para todo repositório cujo próprio conteúdo é
implantado.
