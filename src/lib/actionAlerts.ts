type Confirmation = {
  title: string;
  text: string;
  label: string;
  cancelLabel?: string;
  danger?: boolean;
  source?: HTMLElement;
};
let confirmationActive = false;
let dismissToast: ((target: HTMLElement) => void) | undefined;

export function dismissActionToast(target: HTMLElement) { dismissToast?.(target); }

export async function confirmAction({ title, text, label, cancelLabel = 'Cancel', danger, source }: Confirmation) {
  if (confirmationActive) return false;
  confirmationActive = true;
  const opener = source ?? document.activeElement;
  try {
    const { default: Swal } = await import('sweetalert2');
    if (opener && !opener.isConnected) return false;
    const { isConfirmed } = await Swal.fire({
      target: opener?.closest<HTMLDialogElement>('dialog[open]') ?? document.body,
      titleText: title,
      text,
      icon: danger ? 'warning' : 'question',
      confirmButtonText: label,
      cancelButtonText: cancelLabel,
      confirmButtonColor: danger ? '#b91c1c' : '#087e74',
      showCancelButton: true,
      focusCancel: true,
      reverseButtons: true,
      heightAuto: false,
      keydownListenerCapture: true,
      allowOutsideClick: false,
      // Clear the confirmation before a fast save can request its result toast.
      hideClass: { popup: '', backdrop: '' },
      returnFocus: false,
      customClass: { htmlContainer: 'action-confirmation-text' },
      didClose: () => { if (!Swal.isVisible() && opener instanceof HTMLElement && opener.isConnected) opener.focus(); }
    });
    return isConfirmed && (!opener || opener.isConnected);
  } catch {
    // Retain explicit confirmation even if the dialog bundle cannot be loaded.
    return (!opener || opener.isConnected) && window.confirm(`${title}\n\n${text}`);
  } finally { confirmationActive = false; }
}

async function showActionToast(title: string, icon: 'success' | 'error' | 'warning') {
  try {
    const { default: Swal } = await import('sweetalert2');
    if (confirmationActive || (Swal.isVisible() && !Swal.getPopup()?.classList.contains('swal2-toast'))) return;
    const target = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1) ?? document.body;
    const toast = Swal.fire({
      target,
      toast: true, position: 'top-end', icon, titleText: title,
      showConfirmButton: false, showCloseButton: true, timer: icon === 'success' ? 3500 : 5500,
      heightAuto: false, returnFocus: false, hideClass: { popup: '', backdrop: '' }
    });
    const dismiss = (closing: HTMLElement) => {
      const popup = Swal.getPopup();
      if (closing === target && popup?.classList.contains('swal2-toast') && closing.contains(popup)) Swal.close();
    };
    dismissToast = dismiss;
    try { await toast; } finally { if (dismissToast === dismiss) dismissToast = undefined; }
  } catch {
    // Feedback must not change the outcome of the requested action.
  }
}

export const showSuccessToast = (title: string) => showActionToast(title, 'success');
export const showErrorToast = (title: string) => showActionToast(title, 'error');
export const showWarningToast = (title: string) => showActionToast(title, 'warning');
