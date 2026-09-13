# A CI de segurança estava vermelha desde o primeiro push

**Quando:** descoberto em 13/09/2026, na auditoria retrógrada.
**Onde:** workflow `Segurança` (`.github/workflows/seguranca.yml`).

## O que aconteceu

O workflow foi criado em 12/09 e rodou **quatro vezes**, uma por push.
**As quatro falharam.** Ninguém olhou — inclusive eu, que registrei a
pendência "CI verde ainda não verificado" e segui trabalhando por dois
dias como se fosse detalhe de conferência.

Nesse intervalo a Estação 3 foi tratada como fechada, e o `CLAUDE.md`
dizia `3 Fundação | 12/09 | .github/workflows/, este arquivo`. A
evidência citada era **a existência do arquivo**, não a execução verde.

## Por que falhava

O job `estatica` (semgrep) terminou com código 1 em todas as execuções.
Seis achados, todos da mesma regra e **todos nos dois arquivos de
workflow** — nenhum em `src/`, nenhum no caminho do dinheiro:

```
yaml.github-actions.security.github-actions-mutable-action-tag
  .github/workflows/ci.yml         → uses: actions/checkout@v4
                                     uses: actions/setup-node@v4
  .github/workflows/seguranca.yml  → idem, nos três jobs
```

A regra é legítima e o motivo dela é concreto: `@v4` é uma referência
móvel. Quem controla a ação pode repontar a tag em silêncio, e o CI passa
a executar outro código com a credencial do repositório — foi assim nos
comprometimentos do `trivy-action` e do `kics-github-action`. A correção
é fixar o SHA de 40 caracteres.

Os jobs `dependencias` e `segredos` passaram nas quatro execuções.

## A causa raiz, que não é o semgrep

**"Existe" foi aceito como evidência de "funciona".** A lei já dizia que
fechar é reverificar com evidência — execução verde, URL que responde,
migration aplicada — e que nunca se escreve que algo existe antes de
existir. Escrever `evidência: .github/workflows/` cumpria a letra e
matava o sentido: o arquivo existia, a verificação não passava, e o
`CLAUDE.md` afirmava com confiança uma coisa que era falsa.

O agravante é o tipo de item: verificação automática que falha é
**silenciosa por natureza**. Teste que quebra na sua máquina te
interrompe; CI vermelha numa aba que ninguém abre não interrompe
ninguém. Foi exatamente o modo de falha que ela existe para impedir,
acontecendo com ela mesma.

## O que fica

- **Evidência de CI é a execução, com número da run e veredito** — nunca
  o caminho do arquivo. Vale para toda estação que cita CI.
- **Pendência que diz "ainda não verificado" bloqueia**, e bloquear
  significa parar, não anotar. Esta ficou aberta dois dias enquanto a
  esteira andava; foi o mesmo erro já registrado em
  `2026-09-11-abri-a-estacao-seguinte-com-a-anterior-aberta.md`,
  repetido.
- **Ação de terceiro se fixa por SHA**, não por tag — inclusive em
  projeto pequeno, porque a credencial que o workflow carrega é a do
  repositório inteiro.
- Arquivo em `.github/workflows/` só o dono aplica: a ferramenta remota
  recusa escrita ali, de propósito, e o ciclo pausa até ele colar.

## Corrigido

O dono colou os dois workflows com SHA fixo e empurrou em `5f3adf3`
("ultima atualização local"), em 13/09/2026.

**Evidência, no formato que esta lição exige** — a execução, não o
arquivo:

| workflow | run | commit | veredito |
|---|---|---|---|
| `Segurança` | **#5** | `5f3adf3` | **success** (os três jobs: `dependencias`, `segredos`, `estatica`) |
| `testes` | #22 | `5f3adf3` | success |

Os SHAs foram reconferidos contra o upstream em 13/09, depois do push,
por `git ls-remote`, e batem com a tag que o comentário ao lado declara:
`actions/checkout@11d5960a326750d5838078e36cf38b85af677262` = `v4`, e
`actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` = `v4`
(hoje `v4.4.0`). Conferir o SHA **depois** de fixar faz parte: fixar por
SHA errado tem a mesma cara de fixar por SHA certo, e o CI verde não
distingue os dois.
