import { FileRunLog } from "../runlog/store.ts";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const runLog = new FileRunLog(process.env.PENNY_RUNLOG ?? "data/runs.jsonl");
const app = createApp({ runLog });

app.listen(port, () => {
  console.log(`Penny is running at http://localhost:${port}`);
});
