/** Hook de resolução: qualquer import de `src/config/supabase.js` vira o cliente falso. */
export async function resolve(specifier, context, nextResolve) {
  const resolvido = await nextResolve(specifier, context);
  if (/\/src\/config\/supabase\.js$/.test(resolvido.url)) {
    return { url: new URL('./supabase-falso.mjs', import.meta.url).href, shortCircuit: true };
  }
  return resolvido;
}
