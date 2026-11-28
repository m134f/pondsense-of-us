type Confirmation = {
  title: string;
  text: string;
  label: string;
  cancelLabel?: string;
  danger?: boolean;
  source?: HTMLElement;
};
let confirmationActive = false;

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
      customClass: { htmlContainer: 'action-confirmation-text' },
      didClose: () => { if (!Swal.isVisible() && opener instanceof HTMLElement && opener.isConnected) opener.focus(); }
    });
    return isConfirmed && (!opener || opener.isConnected);
  } catch {
    // Retain explicit confirmation even if the dialog bundle cannot be loaded.
    return (!opener || opener.isConnected) && window.confirm(`${title}\n\n${text}`);
  } finally { confirmationActive = false; }
}

export async function showSuccessToast(title: string) {
  try {
    const { default: Swal } = await import('sweetalert2');
    if (confirmationActive || (Swal.isVisible() && !Swal.getPopup()?.classList.contains('swal2-toast'))) return;
    await Swal.fire({ toast: true, position: 'top-end', icon: 'success', titleText: title,
      showConfirmButton: false, timer: 3000, returnFocus: false });
  } catch {
    // A failed notification does not change the result of the saved action.
  }
}
