import { useEffect, useState } from "react";
import type { PublicCircle } from "../shared";
import { api } from "./api";
import { ErrorNote, Qr, Spinner } from "./ui";

/** A sheet of wallet-size cards to hand out at the service. */
export default function PrintCards({ code }: { code: string }) {
	const [c, setC] = useState<PublicCircle | null>(null);
	const [error, setError] = useState("");
	const link = `${location.origin}/porchlight/c/${code}`;

	useEffect(() => {
		api.circle(code).then(setC, (e: Error) => setError(e.message));
	}, [code]);

	if (error) return <ErrorNote error={error} />;
	if (!c) return <Spinner />;

	return (
		<div className="pl-print">
			<div className="pl-print__bar">
				<button className="pl-btn pl-btn--primary" onClick={() => window.print()}>
					Print
				</button>
				<span className="pl-muted">Eight cards per page. Cut along the lines.</span>
			</div>
			<div className="pl-print__sheet">
				{Array.from({ length: 8 }, (_, i) => (
					<div className="pl-print__card" key={i}>
						<Qr value={link} size={96} />
						<div>
							<div className="pl-print__title">Remembering {c.lovedOneName}</div>
							<p>
								Want to support {c.grieverName} in the weeks ahead? Scan to see what helps right now, and get a gentle
								text when that changes.
							</p>
							<div className="pl-print__url">{link.replace(/^https?:\/\//, "")}</div>
							<div className="pl-print__brand">
								Porchlight{c.sponsor ? ` · with care from ${c.sponsor}` : ""}
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
