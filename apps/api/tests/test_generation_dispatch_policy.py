"""Contract integration for Issue #58 generation dispatch.

No live provider credential: fake transport proves the policy refuses unsafe
requests BEFORE a generation provider can receive one.
"""

from __future__ import annotations

import pytest

from gandiwa_api.creative.dispatch_policy import (
    GenerationDispatchError,
    dispatch_generation,
    prompt_snapshot_digest,
)
from gandiwa_api.creative.models import CreativeSession, PromptSnapshot, StockConstraints


class FakeGenerationTransport:
    def __init__(self, result: dict[str, object] | Exception | None = None) -> None:
        self.calls: list[dict[str, object]] = []
        self.result = result or {"provider_job_id": "fake-job-123", "seed": 7}

    def submit(self, payload: dict[str, object]) -> dict[str, object]:
        self.calls.append(payload)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def valid_session(*, approved: bool = True) -> CreativeSession:
    session = CreativeSession(
        topic="ceramic mug",
        human_prompt_approval=approved,
        prompt=PromptSnapshot(
            prompt_text="Editorial ceramic mug on linen, 2400x1667 output",
            negative_prompt_text="logo, brand, watermark, random text",
            content_type="raster",
            creation_method="generative_ai",
            provider_id="fal",
            model_id="fal-ai/flux/dev",
            target_width=2400,
            target_height=1667,
            aspect_ratio="3:2",
            orientation="landscape",
            stock_constraints=StockConstraints(
                no_logo=True,
                no_brand=True,
                no_watermark=True,
                no_random_text=True,
                no_fake_ui=True,
                no_unintentional_crop=True,
                no_malformed_anatomy=True,
                no_copyrighted_property=True,
                negative_space_decision="right third open",
            ),
        ),
    )
    if approved:
        session.approved_prompt_digest = prompt_snapshot_digest(session)
    return session


def test_dispatch_refuses_unapproved_exact_prompt_before_provider_call() -> None:
    transport = FakeGenerationTransport()

    with pytest.raises(GenerationDispatchError, match="human approval"):
        dispatch_generation(valid_session(approved=False), transport)

    assert transport.calls == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("content_type", "vector"),
        ("creation_method", "camera"),
        ("orientation", "portrait"),
    ],
)
def test_dispatch_refuses_when_any_approved_prompt_field_changes(field: str, value: str) -> None:
    transport = FakeGenerationTransport()
    session = valid_session()
    setattr(session.prompt, field, value)

    with pytest.raises(GenerationDispatchError, match="exact prompt snapshot"):
        dispatch_generation(session, transport)

    assert transport.calls == []


def test_dispatch_refuses_when_approved_stock_constraints_change() -> None:
    transport = FakeGenerationTransport()
    session = valid_session()
    assert session.prompt.stock_constraints is not None
    session.prompt.stock_constraints.no_fake_ui = False

    with pytest.raises(GenerationDispatchError, match="exact prompt snapshot"):
        dispatch_generation(session, transport)

    assert transport.calls == []


def test_dispatch_refuses_unregistered_provider_before_provider_call() -> None:
    transport = FakeGenerationTransport()
    session = valid_session()
    session.prompt.provider_id = "unregistered-provider"
    session.approved_prompt_digest = prompt_snapshot_digest(session)

    with pytest.raises(GenerationDispatchError, match="not registered"):
        dispatch_generation(session, transport)

    assert transport.calls == []


def test_dispatch_refuses_model_registered_to_a_different_provider() -> None:
    transport = FakeGenerationTransport()
    session = valid_session()
    session.prompt.model_id = "futuregen/ultra-image"
    session.approved_prompt_digest = prompt_snapshot_digest(session)

    with pytest.raises(GenerationDispatchError, match="not registered"):
        dispatch_generation(
            session,
            transport,
            provider_models={"fal": {"fal-ai/flux/dev"}, "futuregen": {"futuregen/ultra-image"}},
        )

    assert transport.calls == []


def test_dispatch_accepts_deliberately_registered_future_provider_model_pair() -> None:
    transport = FakeGenerationTransport()
    session = valid_session()
    session.prompt.provider_id = "futuregen"
    session.prompt.model_id = "futuregen/ultra-image"
    session.approved_prompt_digest = prompt_snapshot_digest(session)

    result = dispatch_generation(
        session,
        transport,
        provider_models={"futuregen": {"futuregen/ultra-image"}},
    )

    assert result.provider_job_id == "fake-job-123"
    assert len(transport.calls) == 1
    assert transport.calls[0]["provider"] == "futuregen"
    assert transport.calls[0]["model"] == "futuregen/ultra-image"


def test_dispatch_refuses_failed_gate_before_provider_call() -> None:
    transport = FakeGenerationTransport()
    session = valid_session()
    session.prompt.target_width = 800
    session.prompt.target_height = 600

    with pytest.raises(GenerationDispatchError, match="GENERATION_READY"):
        dispatch_generation(session, transport)

    assert transport.calls == []


def test_dispatch_sends_exact_prompt_and_resolution_parameters_to_provider() -> None:
    transport = FakeGenerationTransport()

    result = dispatch_generation(valid_session(), transport)

    assert result.provider_job_id == "fake-job-123"
    assert transport.calls == [
        {
            "prompt": "Editorial ceramic mug on linen, 2400x1667 output",
            "negative_prompt": "logo, brand, watermark, random text",
            "provider": "fal",
            "model": "fal-ai/flux/dev",
            "width": 2400,
            "height": 1667,
            "aspect_ratio": "3:2",
        }
    ]


def test_dispatch_accepts_registered_future_provider_capability() -> None:
    transport = FakeGenerationTransport()
    session = valid_session()
    session.prompt.provider_id = "futuregen"
    session.prompt.model_id = "futuregen/ultra-image"
    session.approved_prompt_digest = prompt_snapshot_digest(session)

    result = dispatch_generation(
        session,
        transport,
        provider_models={"futuregen": {"futuregen/ultra-image"}},
    )

    assert result.provider_job_id == "fake-job-123"
    assert len(transport.calls) == 1
    assert transport.calls[0]["model"] == "futuregen/ultra-image"


def test_provider_schema_error_fails_closed_without_returning_a_provenance_record() -> None:
    transport = FakeGenerationTransport({"seed": 7})

    with pytest.raises(GenerationDispatchError, match="invalid generation response"):
        dispatch_generation(valid_session(), transport)


def test_dispatch_refuses_resubmitting_the_same_approved_prompt_before_transport() -> None:
    transport = FakeGenerationTransport()
    session = valid_session()
    dispatch_generation(session, transport)

    second = FakeGenerationTransport()
    with pytest.raises(GenerationDispatchError, match="already submitted"):
        dispatch_generation(session, second)

    assert second.calls == []


def test_provider_timeout_fails_closed() -> None:
    transport = FakeGenerationTransport(TimeoutError("slow upstream"))

    with pytest.raises(GenerationDispatchError, match="unreachable"):
        dispatch_generation(valid_session(), transport)


def test_successful_dispatch_records_new_revision_and_provider_provenance() -> None:
    from gandiwa_api.creative.dispatch_policy import dispatch_and_record_generation
    from gandiwa_api.creative.session import SessionService

    service = SessionService(valid_session())
    result = dispatch_and_record_generation(service, FakeGenerationTransport())

    assert result.provider_job_id == "fake-job-123"
    assert len(service.revisions) == 1
    revision = service.current_revision
    assert revision is not None
    assert revision.provenance is not None
    assert revision.provenance.provider_job_id == "fake-job-123"
    assert revision.provenance.model_id == "fal-ai/flux/dev"


def test_failed_dispatch_does_not_create_a_revision() -> None:
    from gandiwa_api.creative.dispatch_policy import dispatch_and_record_generation
    from gandiwa_api.creative.session import SessionService

    service = SessionService(valid_session())
    with pytest.raises(GenerationDispatchError):
        dispatch_and_record_generation(
            service,
            FakeGenerationTransport(TimeoutError("slow upstream")),
        )

    assert service.revisions == []


def test_regenerate_requires_a_fresh_prompt_approval_before_provider_call() -> None:
    from gandiwa_api.creative.dispatch_policy import dispatch_and_record_generation
    from gandiwa_api.creative.session import SessionService

    service = SessionService(valid_session())
    dispatch_and_record_generation(service, FakeGenerationTransport())
    service.regenerate(
        new_prompt_text="Ceramic mug on linen, alternate side light, 2400x1667 output"
    )

    transport = FakeGenerationTransport()
    with pytest.raises(GenerationDispatchError, match="human approval"):
        dispatch_and_record_generation(service, transport)

    assert transport.calls == []


def test_regenerate_dispatch_records_provenance_on_the_new_revision() -> None:
    from gandiwa_api.creative.dispatch_policy import dispatch_and_record_generation
    from gandiwa_api.creative.session import SessionService

    service = SessionService(valid_session())
    dispatch_and_record_generation(service, FakeGenerationTransport())
    service.regenerate(
        new_prompt_text="Ceramic mug on linen, alternate side light, 2400x1667 output"
    )
    service.session.human_prompt_approval = True
    service.session.approved_prompt_digest = prompt_snapshot_digest(service.session)

    dispatch_and_record_generation(service, FakeGenerationTransport())

    assert len(service.revisions) == 2
    assert service.current_revision is not None
    assert service.current_revision.provenance is not None
    assert service.current_revision.provenance.provider_job_id == "fake-job-123"


def test_wrapper_dispatches_with_deliberately_registered_future_provider() -> None:
    from gandiwa_api.creative.dispatch_policy import dispatch_and_record_generation
    from gandiwa_api.creative.session import SessionService

    session = valid_session()
    session.prompt.provider_id = "futuregen"
    session.prompt.model_id = "futuregen/ultra-image"
    session.approved_prompt_digest = prompt_snapshot_digest(session)
    service = SessionService(session)

    dispatch_and_record_generation(
        service,
        FakeGenerationTransport(),
        provider_models={"futuregen": {"futuregen/ultra-image"}},
    )

    assert service.current_revision is not None
    assert service.current_revision.provenance is not None
    assert service.current_revision.provenance.provider_id == "futuregen"
