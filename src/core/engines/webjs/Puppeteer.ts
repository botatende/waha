/**
 * Expose a function to the page if it does not exist
 *
 * NOTE:
 * Rewrite it to 'upsertFunction' after updating Puppeteer to 20.6 or higher
 * using page.removeExposedFunction
 * https://pptr.dev/api/puppeteer.page.removeExposedFunction
 *
 * @param {import(puppeteer).Page} page
 * @param {string} name
 * @param {Function} fn
 */
const PAGE_BINDING_RETRY_DELAYS_MS = [250, 500, 1000, 1500, 2500];
const pageBindingQueues = new WeakMap<
  object,
  Map<string, Promise<void>>
>();

const isRecoverablePageBindingError = (error) =>
  /Execution context was destroyed|detached Frame|Cannot find context|already exists|navigation/i.test(
    String(error?.message || error),
  );

export async function exposeFunctionIfAbsent(page, name, fn) {
  let bindings = pageBindingQueues.get(page);
  if (!bindings) {
    bindings = new Map<string, Promise<void>>();
    pageBindingQueues.set(page, bindings);
  }

  const previous = bindings.get(name) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    let lastError;

    for (
      let attempt = 0;
      attempt <= PAGE_BINDING_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        const exists = await page.evaluate((bindingName) => {
          return !!window[bindingName];
        }, name);

        if (exists) {
          return;
        }

        await page.exposeFunction(name, fn);
        return;
      } catch (error) {
        lastError = error;

        if (/already exists/i.test(String(error?.message || error))) {
          const exists = await page
            .evaluate((bindingName) => !!window[bindingName], name)
            .catch(() => false);

          if (exists) {
            return;
          }
        }

        if (
          !isRecoverablePageBindingError(error) ||
          attempt >= PAGE_BINDING_RETRY_DELAYS_MS.length
        ) {
          throw error;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, PAGE_BINDING_RETRY_DELAYS_MS[attempt]),
        );
      }
    }

    throw lastError;
  });

  bindings.set(name, operation);

  try {
    await operation;
  } finally {
    if (bindings.get(name) === operation) {
      bindings.delete(name);
    }
  }
}
