# Auditei contra uma cópia velha do repositório, não contra o disco

**Sintoma.** Dois achados de auditoria descreviam um estado que não
existia mais: "os módulos `driveService.js`, `emailService.js` e
`config/googleDrive.js` continuam no repositório" e "o código ainda lê
as credenciais `GOOGLE_*` e `SMTP_*`". Os dois viraram ordem de
remoção, e o `git rm` falhou com
`fatal: pathspec ... did not match any files` — os arquivos tinham sido
apagados semanas antes.

**Causa raiz.** A varredura rodou sobre a **cópia de trabalho trazida no
início da sessão**, não sobre o disco. Essa cópia é uma fotografia com
hora: no momento em que foi tirada os arquivos existiam; quando a
análise rodou, não existiam mais.

O agravante: a listagem correta do disco já tinha sido consultada na
mesma sessão e **já não mostrava nenhum dos três**. A cópia velha foi
usada porque era mais cômoda de varrer com `grep`, e a comodidade venceu
a fonte da verdade.

**Correção.** Refazer as duas checagens contra arquivos trazidos na
hora. Resultado: nenhuma referência de código aos módulos, nenhuma
leitura de `GOOGLE_*`/`SMTP_*`, `.env.example` sem essas chaves e
`package.json` sem `googleapis`/`nodemailer`. Os dois achados foram
retirados.

**Como evitar na origem.** Cópia local é cache, e cache tem idade.
Antes de afirmar que um arquivo existe ou não existe — e sempre antes de
transformar isso em ordem de apagar ou mover — reler a listagem do disco,
que custa uma chamada. Vale a regra geral: **afirmação sobre o estado do
projeto sai da fonte da verdade, não da cópia mais fácil de consultar.**
