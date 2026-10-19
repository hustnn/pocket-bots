// npm run service -- install | uninstall | status | print
import { runService } from "./service";

process.exitCode = await runService(process.argv.slice(2));
