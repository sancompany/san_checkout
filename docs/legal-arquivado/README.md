# Versões anteriores dos documentos legais

A skill `legal` manda arquivar versão antiga, e o motivo é direto:
**quem aceitou a anterior aceitou aquela, não a atual.** Sem a cópia,
não há como dizer o que a pessoa concordou.

| versão | vigência | operador identificado | o que caracteriza | arquivo |
|---|---|---|---|---|
| **v1** | até 17/09/2026 | **SAN & CO.**, CNPJ 68.949.029/0001-58 | identificação por CNPJ | `termos-v1-cnpj-2026-09.html`, `privacidade-v1-cnpj-2026-09.html` |
| **v2** | 17/09/2026, algumas horas | **Bruno Henrique Sanches**, CPF, em transição para PJ | nomeava o **Render** como infraestrutura de aplicação, não declarava a Cloudflare, e prometia comunicação transacional que o sistema não faz | `privacidade-v2-render-2026-09.html` (só a política; os termos não mudaram) |
| **v3** (Política) | 17/09/2026 a 26/09/2026 | **Bruno Henrique Sanches**, CPF, em transição para PJ | Northflank em região brasileira, Cloudflare declarada (Pages, DNS, Access e Web Analytics), e a seção de comunicações dizendo o que existe | `privacidade-v3-pf-transicao-2026-09.html` |
| **v2** (Termos) | 17/09/2026 a 26/09/2026 | **Bruno Henrique Sanches**, CPF, em transição para PJ | identificação por CPF; ainda descrevia o split como o fluxo financeiro, e não tinha seção de assinaturas | `termos-v2-pf-transicao-2026-09.html` |
| **v4** (Política) e **v3** (Termos) | 26/09/2026 a 11/11/2026 | **Bruno Henrique Sanches**, CPF — **sem** transição anunciada | Termos com seção de assinaturas e fluxo financeiro sem split; Política declarando Google Fonts e ViaCEP, bases legais por finalidade e prazos por categoria | `termos-v3-pf-2026-09.html`, `privacidade-v4-pf-2026-09.html` |
| **v5** (Política) e **v4** (Termos) | desde 11/11/2026 | **68.949.029 BRUNO HENRIQUE SANCHES**, MEI, CNPJ 68.949.029/0001-58, nome comercial SAN & CO.; titular e responsável legal Bruno Henrique Sanches | identificação do empresário individual no lugar do CPF; cláusula fiscal e item 14.1 sem afirmar emissão; item 20.3 (Marco Civil art. 15) deixa de afirmar que não se aplica. Nenhum outro tratamento foi alterado | `public/termos.html`, `public/privacidade.html` (vigentes) |

> **Nota histórica, revertida em 11/11/2026.** Em 26/09/2026 o dono
> decidiu que o CNPJ 68.949.029/0001-58 "pertencia a outra atividade" e
> que não havia transição para pessoa jurídica; os documentos passaram a
> identificar a pessoa física, por CPF. Em **11/11/2026** o dono
> formalizou a operação nesse mesmo MEI (nome empresarial
> `68.949.029 BRUNO HENRIQUE SANCHES`) e a decisão foi revertida: o CNPJ
> é, de novo, a identificação vigente. As linhas "em transição para PJ" e
> "CPF" acima são o que esteve no ar em cada época, e as cópias são
> exatas. Nenhuma delas foi alterada.

**Os dois documentos não andam no mesmo passo, e isso é proposital:** a
numeração de cada um só avança quando o conteúdo dele muda. Em
17/09/2026 só a Política mudou (v3), porque corrigia fatos de
infraestrutura e de tratamento de dados, e os Termos ficaram na v2.
De 26/09/2026 a 11/11/2026 as versões vigentes foram **Termos v3** e
**Política v4**; desde 11/11/2026 são **Termos v4** e **Política v5**,
conforme a tabela acima. Versionar um documento que não mudou só
cria uma data falsa.

## Por que a v1 não precisou ser comunicada a ninguém

**Ninguém a aceitou.** A v1 esteve no ar durante a Estação 5 e a 6, com
o checkout fechado a terceiro: sem divulgação, sem link enviado, sem
cadastro aberto — que é exatamente o que a lei das estações exige antes
da Estação 7 (`leis`: "subir não é lançar"). O único contratante
cadastrado é do mesmo dono do checkout, confirmado por ele em 17/09.

Se a v1 tivesse sido aceita por um terceiro, a regra seria outra: avisar
quem já usava, e manter a v1 acessível a essa pessoa — não só
arquivada aqui.

## Como foram capturadas

`git show 1c4f1c7:public/termos.html` e o equivalente da privacidade —
o commit imediatamente anterior à troca de identificação (`4c02b65`).
São o arquivo exato que esteve no ar, não uma reconstrução.

A v2 da política saiu do mesmo jeito, por `git show HEAD:public/privacidade.html`
antes de a v3 ser escrita. **O histórico do git é o que torna isso
possível**, e é a razão de a captura nunca ser feita "de memória": o
arquivo arquivado é byte a byte o que o navegador recebeu.

## As cópias de 26/09/2026

`termos-v2-pf-transicao-2026-09.html` e
`privacidade-v3-pf-transicao-2026-09.html` saíram de `git show
HEAD:public/termos.html` e `git show HEAD:public/privacidade.html`, com
`HEAD` no merge `d1af4a5` da `main`, antes de os vigentes serem
reescritos. Foram conferidas com `cmp` contra os arquivos que estavam em
`public/`: idênticas byte a byte.

## As cópias de 11/11/2026

`termos-v3-pf-2026-09.html` e `privacidade-v4-pf-2026-09.html` saíram de
`git show HEAD:public/termos.html` e `git show HEAD:public/privacidade.html`,
com `HEAD` em `836fdee` (`main`), antes de os vigentes serem reescritos,
e foram conferidas com `cmp`: idênticas byte a byte ao que esteve no ar.
Ninguém externo aceitou as versões anteriores (o único contratante é
projeto do mesmo dono), então nenhuma comunicação a terceiros é devida.
