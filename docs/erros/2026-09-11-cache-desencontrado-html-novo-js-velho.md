# HTML novo servido com JS velho (cache do Pages)

**Sintoma.** Depois de um deploy, o painel administrativo morria no login
com `Cannot set properties of null (setting 'hidden')`. O mesmo código
rodava perfeitamente em ambiente local, e tanto o HTML quanto o JS
publicados na origem estavam corretos e consistentes entre si.

**Causa raiz.** O Cloudflare Pages servia, por padrão,
`Cache-Control: public, max-age=0, must-revalidate` para o HTML e
`public, max-age=14400, must-revalidate` para `.js` e `.css`. HTML sempre
fresco, script e estilo parados por até **4 horas**. O navegador
executava o HTML novo com o JS da versão anterior, que procurava
elementos que aquele HTML não tinha mais.

O mesmo mecanismo deixava o CSS corrigido invisível: a correção estava no
ar e o navegador continuava com a cópia velha.

**Correção — INCOMPLETA, e isto foi descoberto em produção em
11/09/2026.** Foi escrito `Cache-Control: public, max-age=0,
must-revalidate` no bloco `/*` de `public/_headers`, e durante um dia
este registro afirmou que o problema estava resolvido. **Não está.**

Medido ao vivo, com `fetch` e cache desligado, no domínio de produção:

| arquivo | `Cache-Control` servido |
|---|---|
| `/index.html` | `public, max-age=0, must-revalidate` ✅ |
| `/js/admin.js` | `public, max-age=14400, must-revalidate` ❌ |
| `/css/admin.css` | `public, max-age=14400, must-revalidate` ❌ |

O Cloudflare Pages aplica os OUTROS cabeçalhos do bloco `/*` nesses
arquivos — CSP e HSTS chegam nos três, conferido na mesma medição — mas
**sobrepõe o `Cache-Control` dos assets estáticos com a política própria
dele**, de 4 horas. Ou seja: o sintoma original continua vivo. HTML
fresco, JS de até 4 horas atrás, e o painel morrendo no login com
`Cannot set properties of null`.

O que resolve de verdade é uma das duas, e nenhuma está aplicada: uma
**Transform Rule** de resposta na zona, reescrevendo `Cache-Control` para
`/js/*` e `/css/*` (configuração de painel, incluída no plano gratuito),
ou versionar o nome/URL dos assets a cada deploy, que exige passo de
build. Enquanto nenhuma existir, **o contorno é recarregar com
Ctrl+Shift+R depois de todo deploy que mexa em JS ou CSS.**

**Guarda.** Duas, e a primeira só existe porque a primeira correção
passou um dia parecendo certa: **conferir o cabeçalho servido, não o
arquivo escrito.** `fetch(url, {cache:'no-store'}).then(r =>
r.headers.get('cache-control'))` no domínio de produção responde em
segundos o que a leitura do `_headers` não responde — escrever a diretiva
não garante que a plataforma a respeite.

A segunda: o comentário fica **fora** do bloco `/*`, não indentado —
comentário indentado pode não ser reconhecido pelo parser do Pages, e se
o bloco for descartado a CSP cai junto.

**Como evitar na origem.** Deploy de front sem cache-busting precisa de
revalidação forçada. Diagnóstico: quando o código local funciona e o
publicado não, comparar **os headers**, não só o conteúdo dos arquivos —
`fetch(url).then(r => r.headers.get('cache-control'))` resolve em
segundos o que dedução não resolve.

**Ecossistema:** sim, e por dois motivos agora. O primeiro: qualquer
hospedagem estática serve HTML e assets com políticas de cache diferentes
por padrão, e sem cache-busting o navegador roda HTML novo com script
velho. O segundo, mais geral e mais caro: **configuração declarada não é
configuração aplicada.** A plataforma pode aceitar o arquivo, ignorar a
diretiva e não reclamar de nada — e a correção fica um dia inteira no
repositório parecendo pronta.
