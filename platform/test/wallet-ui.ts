import type { Window } from 'happy-dom';

export function waitForUI(win: Window, check: () => boolean) {
  if (check()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Wallet UI did not reach the expected state')); }, 3000);
    const observer = new win.MutationObserver(() => {
      if (check()) { clearTimeout(timer); observer.disconnect(); resolve(); }
    });
    observer.observe(win.document, { subtree: true, attributes: true, childList: true, characterData: true });
  });
}
export function installDialogHooks(win: Window) {
  for (const dialog of win.document.querySelectorAll('.wallet-dialog') as any) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = (value: string) => { dialog.returnValue = value; dialog.open = false; dialog.dispatchEvent(new win.Event('close')); };
  }
}
export async function confirmAccount(win: Window, address?: string) {
  await waitForUI(win, () => (win.document.getElementById('wallet-account-picker') as any).open);
  if (address) {
    const radio = Array.from(win.document.querySelectorAll('input[name="wallet-account"]')).find((input: any) => input.value.toLowerCase() === address.toLowerCase()) as any;
    if (!radio) throw new Error('Chosen account is not offered by this wallet');
    radio.checked = true;
  }
  win.document.getElementById('wallet-account-form')!.dispatchEvent(new win.Event('submit', { cancelable: true }));
}
