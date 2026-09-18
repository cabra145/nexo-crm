const time = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });

/** Hora si es de hoy; si no, el día. */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return date.toDateString() === now.toDateString() ? time.format(date) : day.format(date);
}

export const formatTime = (iso: string) => time.format(new Date(iso));

/** Horas y minutos que quedan hasta `iso`, para la ventana de 24 h. */
export function remaining(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
