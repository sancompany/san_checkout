# Versões anteriores dos documentos legais

A skill `legal` manda arquivar versão antiga, e o motivo é direto:
**quem aceitou a anterior aceitou aquela, não a atual.** Sem a cópia,
não há como dizer o que a pessoa concordou.

| versão | vigência | operador identificado | o que caracteriza | arquivo |
|---|---|---|---|---|
| **v1** | até 17/09/2026 | **SAN & CO.**, CNPJ 68.949.029/0001-58 | identificação por CNPJ | `termos-v1-cnpj-2026-09.html`, `privacidade-v1-cnpj-2026-09.html` |
| **v2** | 17/09/2026, algumas horas | **Bruno Henrique Sanches**, CPF, em transição para PJ | nomeava o **Render** como infraestrutura de aplicação, não declarava a Cloudflare, e prometia comunicação transacional que o sistema não faz | `privacidade-v2-render-2026-09.html` (só a política; os termos não mudaram) |
| **v3** | desde 17/09/2026 | **Bruno Henrique Sanches**, CPF, em transição para PJ | Northflank em região brasileira, Cloudflare declarada (Pages, DNS, Access e Web Analytics), e a seção de comunicações dizendo o que existe | `public/termos.html` (segue v2), `public/privacidade.html` (vigentes) |

**Os dois documentos não andam no mesmo passo, e isso é proposital:** a
v3 corrige fatos de infraestrutura e de tratamento de dados, que vivem
na Política. Os Termos não afirmam nada sobre fornecedor, então
continuam na v2 — versionar um documento que não mudou só cria uma data
falsa.

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
