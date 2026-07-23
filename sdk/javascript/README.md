# Quilo JavaScript SDK

```bash
npm install @quilo/sdk
```

```js
import { Quilo } from "@quilo/sdk";

const quilo = new Quilo({ apiKey: process.env.QUILO_ACCESS_TOKEN });
const estimate = await quilo.pdf.estimate("input.pdf");
const job = await quilo.pdf.translate("input.pdf");
await quilo.jobs.wait(job.id);
await quilo.jobs.download(job.id, "translated.pdf");
```

장기 액세스 토큰은 브라우저 번들에 넣지 말고 신뢰할 수 있는 Node.js 서버에서 사용하세요.
