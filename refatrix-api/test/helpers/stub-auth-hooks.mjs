const STUB = new URL('./authGuardStub.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (/\/middleware\/authGuard\.js$/.test(specifier) && !String(context.parentURL || '').endsWith('authGuardStub.mjs')) {
    return { url: STUB, shortCircuit: true };
  }
  return next(specifier, context);
}
