import nodemailer from 'nodemailer';
import { env } from '$env/dynamic/private';

/**
 * Branded report e-mails, in PerguntAI's own visual language: cream surfaces,
 * ink header/footer, terracotta accent, serif title — a 600px table layout
 * with inline styles only, because Outlook renders with Word's engine.
 *
 * Design rule (agreed): the MODEL never writes raw e-mail HTML — hand-written
 * markup breaks silently for half the recipients. The model fills a
 * constrained schema (subject, greeting, markdown body, optional CTA) and
 * this module renders it through ONE tested template; rich layout freedom
 * lives in the attached PDF.
 */

// The app's palette, mirrored for e-mail (see app.css / Tailwind classes):
// ink #262624 · cream #faf9f5 · canvas #f0eee6 · border #e3e0d5
// accent #d97757 (hover #bd5d3a) · body text #3d3c38 · muted #73726c
const INK = '#262624';
const CREAM = '#faf9f5';
const CANVAS = '#f0eee6';
const BORDER = '#e3e0d5';
const ACCENT = '#d97757';
const TEXT = '#3d3c38';
const MUTED = '#a8a49a';

export function emailConfig() {
	const from = env.SMTP_FROM_ADDRESS ?? '';
	const fromDomain = from.includes('@') ? from.split('@')[1].toLowerCase() : '';
	const allowedDomains = (env.EMAIL_ALLOWED_DOMAINS ?? fromDomain)
		.split(',')
		.map((d) => d.trim().toLowerCase().replace(/^@/, ''))
		.filter(Boolean);
	return {
		configured: Boolean(env.SMTP_HOST && env.SMTP_USERNAME && env.SMTP_PASSWORD && from),
		host: env.SMTP_HOST ?? '',
		port: Number(env.SMTP_PORT ?? 587),
		username: env.SMTP_USERNAME ?? '',
		password: env.SMTP_PASSWORD ?? '',
		from,
		fromName: env.SMTP_FROM_NAME || 'PerguntAI',
		/** Recipient domains allowed (default: the FROM address's own domain). */
		allowedDomains,
		brandName: env.EMAIL_BRAND_NAME || 'PerguntAI',
		brandTag: env.EMAIL_BRAND_TAG || '',
		/** Optional hosted PNG/JPG (SVG is not rendered by Outlook). */
		logoUrl: env.EMAIL_LOGO_URL || '',
		footerText: env.EMAIL_FOOTER_TEXT || 'Este e-mail foi gerado automaticamente pelo PerguntAI.'
	};
}

const esc = (s: string) =>
	s
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');

/**
 * Markdown subset → inline-styled table-safe HTML: paragraphs, ###/## headings,
 * **bold**, *italic*, `code`, - lists, and pipe tables. Everything is escaped
 * first — the model's content can never smuggle markup into the template.
 */
export function markdownToEmailHtml(markdown: string): string {
	const inline = (t: string) =>
		esc(t)
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/\*([^*]+)\*/g, '<em>$1</em>')
			.replace(
				/`([^`]+)`/g,
				`<code style="background:${CANVAS};border-radius:3px;padding:1px 5px;font-size:13px;">$1</code>`
			);

	const blocks = markdown.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
	const out: string[] = [];
	for (const block of blocks) {
		const lines = block
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		if (!lines.length) continue;

		if (lines.every((l) => /^[-*] /.test(l))) {
			out.push(
				`<ul style="margin:0 0 16px;padding-left:22px;">${lines
					.map((l) => `<li style="margin:0 0 6px;">${inline(l.slice(2))}</li>`)
					.join('')}</ul>`
			);
			continue;
		}
		if (lines.length >= 2 && lines[0].includes('|') && /^\|?[\s:|-]+\|?$/.test(lines[1])) {
			const cells = (l: string) =>
				l
					.replace(/^\||\|$/g, '')
					.split('|')
					.map((c) => c.trim());
			const header = cells(lines[0]);
			const rows = lines.slice(2).map(cells);
			const cellStyle = `padding:8px 12px;border-bottom:1px solid ${BORDER};text-align:left;font-size:13px;`;
			out.push(
				`<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 16px;">` +
					`<tr>${header.map((h) => `<th style="${cellStyle}background:${INK};color:${CREAM};font-weight:bold;">${inline(h)}</th>`).join('')}</tr>` +
					rows
						.map(
							(r, i) =>
								`<tr style="background:${i % 2 ? CREAM : '#FFFFFF'};">${r.map((c) => `<td style="${cellStyle}color:${TEXT};">${inline(c)}</td>`).join('')}</tr>`
						)
						.join('') +
					`</table>`
			);
			continue;
		}
		const heading = /^(#{2,4}) (.+)$/.exec(lines[0]);
		if (heading && lines.length === 1) {
			out.push(
				`<h3 style="margin:20px 0 10px;color:${INK};font-size:16px;font-family:Georgia,serif;">${inline(heading[2])}</h3>`
			);
			continue;
		}
		out.push(`<p style="margin:0 0 16px;">${lines.map(inline).join('<br/>')}</p>`);
	}
	return out.join('\n');
}

export interface ReportEmailOptions {
	title: string;
	/** Already-rendered inner HTML (from markdownToEmailHtml). */
	bodyHtml: string;
	greeting?: string;
	ctaText?: string;
	ctaUrl?: string;
	attachmentFilename?: string;
	attachmentKind?: string;
}

export function renderReportEmail(opts: ReportEmailOptions): string {
	const config = emailConfig();
	const { title, bodyHtml, greeting, ctaText, ctaUrl, attachmentFilename, attachmentKind } = opts;

	const brand = config.logoUrl
		? `<img src="${config.logoUrl}" alt="${esc(config.brandName)}" width="130" style="display:block;border:0;"/>`
		: `<span style="color:${CREAM};font-size:18px;font-weight:bold;letter-spacing:0.3px;font-family:Georgia,serif;">${esc(config.brandName)}</span>`;

	const ctaBlock =
		ctaText && ctaUrl
			? `
      <tr><td style="background:#FFFFFF; padding:28px 40px 16px; text-align:center;">
        <a href="${esc(ctaUrl)}" style="
          background-color: ${ACCENT}; color: #ffffff; font-family: Arial, sans-serif;
          font-size: 14px; font-weight: bold; text-decoration: none; padding: 13px 32px;
          border-radius: 8px; display: inline-block; letter-spacing: 0.4px;
        ">${esc(ctaText)}</a>
      </td></tr>`
			: '';

	const attachmentBlock = attachmentFilename
		? `
      <tr><td style="background:#FFFFFF; padding:8px 40px 28px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="background:${CREAM};border:1px solid ${BORDER};border-left:4px solid ${ACCENT};border-radius:6px;padding:12px 16px;">
            <span style="font-size:13px;color:${INK};font-family:Arial,sans-serif;">
              O relatório completo está anexado como <strong>${esc(attachmentKind ?? 'arquivo')}</strong> — <em>${esc(attachmentFilename)}</em>.
            </span>
          </td>
        </tr></table>
      </td></tr>`
		: '';

	return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background-color:${CANVAS};font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0"
  style="max-width:600px;width:100%;border-radius:8px;overflow:hidden;box-shadow:0 4px 20px rgba(38,38,36,0.10);">

  <!-- header: ink with brand -->
  <tr><td style="background:${INK}; padding:22px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>${brand}</td>
      <td align="right" style="vertical-align:middle;">
        <span style="color:${MUTED};font-size:10px;font-weight:bold;letter-spacing:2.5px;text-transform:uppercase;font-family:Arial,sans-serif;">${esc(config.brandTag)}</span>
      </td>
    </tr></table>
  </td></tr>

  <!-- accent bar -->
  <tr><td style="background:${ACCENT};height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>

  <!-- title band: cream, serif -->
  <tr><td style="background:${CREAM}; border-bottom:1px solid ${BORDER}; padding:26px 40px 24px;">
    <h1 style="margin:0;color:${INK};font-size:22px;font-weight:bold;line-height:1.35;font-family:Georgia,serif;">${esc(title)}</h1>
  </td></tr>

  <!-- body -->
  <tr><td style="background:#FFFFFF; padding:32px 40px 12px;">
    ${greeting ? `<p style="margin:0 0 20px;color:${INK};font-size:15px;line-height:1.65;font-family:Arial,sans-serif;font-weight:600;">${esc(greeting)}</p>` : ''}
    <div style="color:${TEXT};font-size:15px;line-height:1.75;font-family:Arial,sans-serif;">${bodyHtml}</div>
  </td></tr>

  ${ctaBlock}
  ${attachmentBlock}

  <tr><td style="background:#FFFFFF; padding:0 40px;"><hr style="border:none;border-top:1px solid ${BORDER};margin:0;"/></td></tr>

  <!-- footer: ink -->
  <tr><td style="background:${INK}; padding:20px 40px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">
        <p style="margin:0;color:${MUTED};font-size:11px;font-family:Arial,sans-serif;">${esc(config.footerText)} &copy; ${new Date().getFullYear()}</p>
      </td>
      <td align="right" style="vertical-align:middle;padding-left:16px;"><span style="font-size:18px;">🤖</span></td>
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export interface SendReportInput {
	to: string[];
	subject: string;
	bodyMarkdown: string;
	greeting?: string;
	ctaText?: string;
	ctaUrl?: string;
	attachment?: { filename: string; content: Buffer; contentType: string };
}

/** Validates recipients against the allowed domains; returns the rejects. */
export function invalidRecipients(to: string[]): string[] {
	const { allowedDomains } = emailConfig();
	return to.filter((addr) => {
		const at = addr.lastIndexOf('@');
		if (at < 1) return true;
		const domain = addr.slice(at + 1).toLowerCase();
		return allowedDomains.length > 0 && !allowedDomains.includes(domain);
	});
}

export async function sendReportEmail(input: SendReportInput): Promise<{ messageId: string }> {
	const config = emailConfig();
	if (!config.configured) throw new Error('SMTP is not configured (SMTP_* env)');

	const transporter = nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.port === 465,
		auth: { user: config.username, pass: config.password }
	});

	const html = renderReportEmail({
		title: input.subject,
		bodyHtml: markdownToEmailHtml(input.bodyMarkdown),
		greeting: input.greeting,
		ctaText: input.ctaText,
		ctaUrl: input.ctaUrl,
		attachmentFilename: input.attachment?.filename,
		attachmentKind: input.attachment
			? (input.attachment.filename.split('.').pop() ?? 'arquivo').toUpperCase()
			: undefined
	});

	const info = await transporter.sendMail({
		from: `"${config.fromName}" <${config.from}>`,
		to: input.to.join(', '),
		subject: input.subject,
		html,
		attachments: input.attachment
			? [
					{
						filename: input.attachment.filename,
						content: input.attachment.content,
						contentType: input.attachment.contentType
					}
				]
			: []
	});
	return { messageId: info.messageId };
}
