import { connect } from 'cloudflare:sockets';
import slugify from '@sindresorhus/slugify';

type EmailStatus = { success: boolean; error?: string };

function toBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function wrapBase64(b64: string): string {
	return b64.replace(/(.{76})/g, '$1\r\n');
}

// SMTP requires any body line starting with "." to be escaped with an extra "." (RFC 5321 4.5.2)
function dotStuff(body: string): string {
	return body.replace(/\r\n\./g, '\r\n..');
}

class SmtpClient {
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private buffer = '';
	private encoder = new TextEncoder();
	private decoder = new TextDecoder();

	constructor(private socket: Socket) {
		this.writer = socket.writable.getWriter();
		this.reader = socket.readable.getReader();
	}

	private async readLine(): Promise<string> {
		while (!this.buffer.includes('\r\n')) {
			const { value, done } = await this.reader.read();
			if (done) throw new Error('SMTP connection closed unexpectedly');
			this.buffer += this.decoder.decode(value, { stream: true });
		}
		const idx = this.buffer.indexOf('\r\n');
		const line = this.buffer.slice(0, idx);
		this.buffer = this.buffer.slice(idx + 2);
		return line;
	}

	async readResponse(): Promise<string> {
		let line = await this.readLine();
		let full = line;
		while (line.charAt(3) === '-') {
			line = await this.readLine();
			full += '\n' + line;
		}
		const code = parseInt(full.slice(0, 3), 10);
		if (code >= 400) throw new Error(`SMTP error: ${full}`);
		return full;
	}

	async writeRaw(data: string) {
		await this.writer.write(this.encoder.encode(data));
	}

	async command(line: string): Promise<string> {
		await this.writeRaw(line + '\r\n');
		return this.readResponse();
	}

	async readGreeting() {
		return this.readResponse();
	}

	async close() {
		try {
			await this.command('QUIT');
		} catch {
			// best-effort
		}
		await this.writer.close().catch(() => {});
	}
}

export default async function send(env: Env, email: string, article: ArrayBuffer, url: string): Promise<EmailStatus> {
	const socket = connect({ hostname: 'smtp.gmail.com', port: 465 }, { secureTransport: 'on', allowHalfOpen: false });
	const client = new SmtpClient(socket);

	try {
		await client.readGreeting();
		await client.command('EHLO web2kindle.workers.dev');
		await client.command('AUTH LOGIN');
		await client.command(btoa(env.GMAIL_USER));
		await client.command(btoa(env.GMAIL_APP_PASSWORD));
		await client.command(`MAIL FROM:<${env.GMAIL_USER}>`);
		await client.command(`RCPT TO:<${email}>`);
		await client.command('DATA');

		const boundary = `web2kindle-${crypto.randomUUID()}`;
		const filename = `${slugify(url)}.pdf`;
		const message = dotStuff(
			[
				`From: ${env.GMAIL_USER}`,
				`To: ${email}`,
				`Subject: New Webpage Order Just Got Delivered!`,
				`MIME-Version: 1.0`,
				`Content-Type: multipart/mixed; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				`Content-Type: text/plain; charset="UTF-8"`,
				'',
				`Here's your freshly baked webpage from web2kindle. Generated from ${url}`,
				'',
				`--${boundary}`,
				`Content-Type: application/pdf; name="${filename}"`,
				`Content-Disposition: attachment; filename="${filename}"`,
				`Content-Transfer-Encoding: base64`,
				'',
				wrapBase64(toBase64(article)),
				'',
				`--${boundary}--`,
			].join('\r\n')
		);

		await client.writeRaw(message + '\r\n.\r\n');
		await client.readResponse();
		await client.close();
		return { success: true };
	} catch (error: any) {
		await client.close().catch(() => {});
		return { success: false, error: error.message };
	}
}
