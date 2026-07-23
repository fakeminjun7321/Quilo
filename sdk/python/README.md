# Quilo Python SDK

Quilo API의 보고서, PDF 통번역, 작업과 파일 API를 Python에서 사용합니다.

```bash
pip install quilo
export QUILO_ACCESS_TOKEN='quilo_...'
```

```python
from quilo import QuiloClient

client = QuiloClient()
estimate = client.pdf.estimate("input.pdf")
job = client.pdf.translate("input.pdf")
completed = client.jobs.wait(job.id)
client.jobs.download(completed.id, "translated.pdf")
```

기본 운영 주소는 `https://quilolab.com`이며 `QUILO_BASE_URL`로 개발 서버를 지정할 수 있습니다.
