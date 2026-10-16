/** All money is integer paise. */

export function formatInr(paise: number): string {
  // pdfkit's built-in fonts have no rupee glyph, so use "Rs."
  return `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function computeDiscount(
  subtotalPaise: number,
  type: 'percent' | 'flat' | null | undefined,
  value: number | null | undefined,
): number {
  if (!type || !value || value <= 0) return 0;
  const raw = type === 'percent' ? Math.floor((subtotalPaise * Math.min(value, 100)) / 100) : value;
  return Math.min(raw, subtotalPaise);
}

export function invoiceStatusFor(totalPaise: number, paidPaise: number): 'pending' | 'partial' | 'paid' {
  if (paidPaise >= totalPaise) return 'paid';
  return paidPaise > 0 ? 'partial' : 'pending';
}
