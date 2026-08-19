import io
import os
import unittest

import httpx

os.environ.setdefault("ENEO_API_BASE", "https://eneo.example.test")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("APP_ACCESS_CODE", "test-code")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("UPLOAD_PROXY_TIMEOUT_SECONDS", "1800")

from app import main  # noqa: E402


class UploadTimeoutTests(unittest.TestCase):
    def setUp(self) -> None:
        main.settings.upload_proxy_timeout_seconds = 1800.0

    def test_upload_timeout_uses_configured_default(self) -> None:
        timeout = main._upload_timeout()

        self.assertEqual(timeout.read, 1800.0)
        self.assertEqual(timeout.write, 1800.0)
        self.assertEqual(timeout.connect, 10.0)
        self.assertEqual(timeout.pool, 30.0)

    def test_upload_timeout_clamps_client_budget(self) -> None:
        too_low = main._upload_timeout(30.0)
        too_high = main._upload_timeout(99_999.0)

        self.assertEqual(too_low.read, 60.0)
        self.assertEqual(too_low.write, 60.0)
        self.assertEqual(too_high.read, 1800.0)
        self.assertEqual(too_high.write, 1800.0)


class FakeUploadFile:
    filename = "meeting.webm"
    content_type = "audio/webm"

    def __init__(self) -> None:
        self.file = io.BytesIO(b"audio")
        self.seek_position: int | None = None

    async def seek(self, offset: int) -> None:
        self.seek_position = offset
        self.file.seek(offset)

    async def read(self) -> bytes:
        raise AssertionError("_proxy_multipart_upload must pass the upload stream")


class FakeHttpClient:
    def __init__(self) -> None:
        self.files = None
        self.timeout = None

    async def post(self, *args, **kwargs):
        self.files = kwargs["files"]
        self.timeout = kwargs["timeout"]

        class FakeResponse:
            content = b'{"id":"file"}'
            status_code = 200
            headers = {"content-type": "application/json"}

        return FakeResponse()


class RaisingHttpClient:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    async def post(self, *args, **kwargs):
        raise self.exc


class UploadProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_proxy_upload_passes_file_stream_without_reading_bytes(self) -> None:
        upload = FakeUploadFile()
        client = FakeHttpClient()
        original_client = main.http_client
        main.http_client = client
        try:
            response = await main._proxy_multipart_upload(
                "https://eneo.example.test/api/v1/flows/flow/steps/step/runtime-files/",
                upload,
                timeout_seconds=120.0,
            )
        finally:
            main.http_client = original_client

        self.assertEqual(response.status_code, 200)
        self.assertEqual(upload.seek_position, 0)
        assert client.files is not None
        _, file_obj, content_type = client.files["upload_file"]
        self.assertIs(file_obj, upload.file)
        self.assertEqual(content_type, "audio/webm")
        self.assertEqual(client.timeout.read, 120.0)

    async def test_proxy_upload_omits_content_type_when_browser_declared_none(
        self,
    ) -> None:
        # Eneo avvisar generiska deklarerade mimetyper (415). Skicka hellre ingen
        # typ alls än vår gamla application/octet-stream-fallback.
        upload = FakeUploadFile()
        upload.content_type = None
        client = FakeHttpClient()
        original_client = main.http_client
        main.http_client = client
        try:
            await main._proxy_multipart_upload(
                "https://eneo.example.test/api/v1/flows/flow/steps/step/runtime-files/",
                upload,
            )
        finally:
            main.http_client = original_client

        assert client.files is not None
        self.assertEqual(len(client.files["upload_file"]), 2)

    async def test_proxy_upload_maps_upstream_timeout_to_504(self) -> None:
        original_client = main.http_client
        main.http_client = RaisingHttpClient(httpx.TimeoutException("stalled"))
        try:
            response = await main._proxy_multipart_upload(
                "https://eneo.example.test/api/v1/flows/flow/steps/step/runtime-files/",
                FakeUploadFile(),
            )
        finally:
            main.http_client = original_client

        self.assertEqual(response.status_code, 504)

    async def test_proxy_upload_maps_upstream_request_error_to_502(self) -> None:
        original_client = main.http_client
        main.http_client = RaisingHttpClient(httpx.ConnectError("unreachable"))
        try:
            response = await main._proxy_multipart_upload(
                "https://eneo.example.test/api/v1/flows/flow/steps/step/runtime-files/",
                FakeUploadFile(),
            )
        finally:
            main.http_client = original_client

        self.assertEqual(response.status_code, 502)


if __name__ == "__main__":
    unittest.main()
