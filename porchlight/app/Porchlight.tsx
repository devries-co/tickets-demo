import CirclePage from "./CirclePage";
import Griever from "./Griever";
import Landing from "./Landing";
import PrintCards from "./PrintCards";
import WorkPage from "./WorkPage";
import "./Porchlight.css";

/** Routes everything under /porchlight. */
export default function Porchlight({ path }: { path: string }) {
	const [, , kind, id, extra] = path.split("/");
	if (kind === "g" && id) return <Griever token={id} away={extra === "away"} />;
	if (kind === "c" && id) return <CirclePage code={id} />;
	if (kind === "w" && id) return <WorkPage code={id} />;
	if (kind === "print" && id) return <PrintCards code={id} />;
	return <Landing />;
}
