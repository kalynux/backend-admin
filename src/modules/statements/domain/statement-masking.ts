/**
 * Masking for identifiers that appear on a statement.
 *
 * The statement goes to the ACCOUNT HOLDER, and it names other people — the customers who
 * bought from a vendor, the agents who carried an agency's parcels. The owner asked for their
 * phone numbers hidden. Same shape as jovi-mall's `maskPhone` (`bot-projections.ts`), so a
 * number looks the same on a statement as it does in a chat: `+2376••••4417`.
 */
export function maskPhone(phone: string | null | undefined): string | null {
    if (!phone) return null;
    const trimmed = phone.replace(/\s+/g, '');
    if (trimmed.length <= 8) return '••••';
    return `${trimmed.slice(0, 5)}••••${trimmed.slice(-4)}`;
}
