# Afirmei o estado do projeto lendo uma cópia velha, não o disco

**Sintoma.** Nenhum na hora — e por isso aconteceu **três vezes no mesmo
dia**, com três caras diferentes.

1. Dois achados de auditoria descreviam um estado que não existia mais
   ("os módulos `driveService.js`, `emailService.js` e
   `config/googleDrive.js` continuam no repositório"). Viraram ordem de
   remoção, e o `git rm` falhou com
   `fatal: pathspec ... did not match any files`: os arquivos tinham
   sido apagados semanas antes.
2. Três documentos (`CONSTRAINTS.md`, `CLAUDE.md` e o cabeçalho do
   `webhookController.js`) passaram uma conversa inteira sem chegar ao
   disco, enquanto eu afirmava que estavam atualizados.
3. O `CONSTRAINTS.md` voltou sozinho para uma versão anterior entre duas
   edições da mesma sessão — com a seção duplicada e fora de ordem que a
   edição anterior tinha acabado de corrigir.

**Causa raiz.** A cópia de trabalho da sessão **não é o projeto**. Ela é
uma fotografia com hora, atualizada por uma transferência assíncrona que
responde "ok" antes de a cópia nova chegar — e uma transferência pedida
antes pode chegar **depois** de uma edição minha e sobrescrevê-la.

O erro por baixo dos três casos é o mesmo, e não é de ferramenta: tratei
a cópia como se fosse o original. No caso 1 havia agravante — a listagem
correta do disco já tinha sido consultada na mesma sessão e já não
mostrava nenhum dos três arquivos. A cópia velha foi usada porque era
mais cômoda de varrer com `grep`, e a comodidade venceu a fonte da
verdade.

**Correção.** Refazer cada checagem contra o disco. No caso 1, os dois
achados foram retirados (nenhuma referência de código aos módulos,
`.env.example` sem as chaves, `package.json` sem `googleapis`/
`nodemailer`). Nos casos 2 e 3, regravar e conferir de novo.

**Guarda.** Verificação por **tamanho em bytes**, lido da listagem do
disco — que é fonte diferente da que foi escrita — antes de editar e
depois de gravar. Foi ela que pegou o caso 3: a gravação respondeu
"escrito" e a listagem mostrou 18471 bytes onde eu tinha mandado 18551.
Reler o próprio arquivo depois de editar **não serve como guarda**: a
releitura acerta a cópia, que é justamente a parte que pode estar errada.

**Como evitar na origem.** Afirmação sobre o estado do projeto sai da
fonte da verdade, nunca da cópia mais fácil de consultar. Trazer o
arquivo imediatamente antes de editar, nunca no começo da sessão "para
ter em mãos". E resposta "sucesso" de um comando não é o mesmo que
trabalho salvo — é a mesma lição que
`2026-09-11-filter-repo-apagou-trabalho-nao-commitado.md` já tinha
gerado, aqui repetindo com outra roupa.

**Ecossistema:** sim — não depende deste código nem desta stack. Vale
para qualquer sessão de agente que enxergue o projeto por uma cópia
sincronizada, que é hoje a forma mais comum de um agente trabalhar.
