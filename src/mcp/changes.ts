type Listener = () => void;

const toolsListeners = new Set<Listener>();
const resourcesListeners = new Set<Listener>();

export function onToolsChanged(cb: Listener): () => void {
  toolsListeners.add(cb);
  return () => toolsListeners.delete(cb);
}

export function onResourcesChanged(cb: Listener): () => void {
  resourcesListeners.add(cb);
  return () => resourcesListeners.delete(cb);
}

export function notifyToolsChanged(): void {
  for (const cb of [...toolsListeners]) {
    try {
      cb();
    } catch {
      /* listener error tidak boleh mematikan broadcaster */
    }
  }
}

export function notifyResourcesChanged(): void {
  for (const cb of [...resourcesListeners]) {
    try {
      cb();
    } catch {
      /* noop */
    }
  }
}