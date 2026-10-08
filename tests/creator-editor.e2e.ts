import { test, expect } from "@playwright/test";
import { startManagedStudio } from "./helpers/managed-studio";
import { createProject } from "../src/domain/catalog";
import { totp } from "../server/advancement/security";

test.use({ ignoreHTTPSErrors: true });
test("managed creator login, invitation registration, read-only role and account isolation use real HTTPS cookies", async ({
  page,
}) => {
  test.setTimeout(120000);
  const service = await startManagedStudio();
  try {
    await page.goto(service.origin);
    await expect(
      page.getByRole("heading", { name: "Automade 제작 작업 공간" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "편집 도구" }),
    ).toHaveCount(0);
    await page.getByLabel("제작자 이메일").fill("browser-admin@example.org");
    await page
      .getByLabel("비밀번호", { exact: true })
      .fill("browser-administrator-test-2026");
    await page
      .getByRole("button", { name: "제작자 로그인", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "편집 도구" }).getByRole("button"),
    ).toHaveCount(8);
    await expect(
      page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
    ).toBeEnabled();
    const project = createProject("관리자만 편집할 원본");
    const setup = await page.evaluate(async (source) => {
      const creator = (await (await fetch("/api/expansion/session")).json())
        .data;
      const api = async (route: string, method = "GET", body?: unknown) => {
        const response = await fetch(route, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Creator-CSRF": creator.csrf,
            "X-CSRF-Token": creator.csrf,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const envelope = await response.json();
        if (!response.ok)
          throw new Error(
            envelope.error?.message || "Managed fixture request failed",
          );
        return envelope.data;
      };
      const bootstrap = await api("/api/expansion/bootstrap");
      const workspace = bootstrap.workspaces[0];
      await api(`/api/projects?workspaceId=${workspace.id}`, "PUT", {
        project: source,
        baseRevision: -1,
      });
      const active = await api(
          `/api/expansion/bootstrap?projectId=${source.id}`,
        ),
        environment = active.environments.find(
          (item: { projectId: string; kind: string }) =>
            item.projectId === source.id && item.kind === "production",
        );
      await api(
        `/api/advancement/runtime/experiments?projectId=${source.id}&environmentId=${environment.id}`,
        "POST",
        {
          name: "읽기 권한 배정 검증",
          hypothesis: "읽기 담당도 자신의 작업 공간 배정을 확인할 수 있다",
          unit: "account",
          metric: "task-completed",
          minSamples: 10,
          guardrailErrorRate: 1,
          variants: [
            { id: "concise", name: "간결" },
            { id: "guided", name: "안내" },
          ],
          durationDays: 1,
        },
      );
      return { workspaceId: workspace.id, environmentId: environment.id };
    }, project);
    await page.reload();
    await expect(page.getByLabel("프로젝트 이름")).toHaveValue(
      "관리자만 편집할 원본",
    );
    await page.getByRole("button", { name: "운영", exact: true }).click();
    const systems = page.locator(".system-panel");
    await systems.locator("summary").first().click();
    await systems
      .getByRole("button", { name: "추가 인증", exact: true })
      .click();
    await systems
      .getByLabel("제작자 비밀번호", { exact: true })
      .fill("browser-administrator-test-2026");
    await systems
      .getByRole("button", { name: "인증 앱 등록·교체 준비" })
      .click();
    const enrollment = page.getByRole("dialog", {
      name: "인증 앱 등록 · 비밀을 안전하게 보관",
    });
    const secret = await enrollment.locator("code").innerText();
    await enrollment.getByLabel("새 인증 앱 코드").fill(totp(secret));
    await enrollment
      .getByRole("button", { name: "등록 확인·복구 코드 발급" })
      .click();
    const recovery = page.getByRole("dialog", {
      name: "일회용 복구 코드 · 지금 보관",
    });
    const recoveryCode = await recovery.locator("li").first().innerText();
    await page.keyboard.press("Escape");
    await expect(recovery).toHaveCount(0);
    await page.getByRole("button", { name: "프로젝트", exact: true }).click();
    await page
      .locator("summary")
      .filter({ hasText: "제작 팀·세부 권한" })
      .click();
    await page
      .getByLabel("초대할 제작자 이메일")
      .fill("browser-viewer@example.org");
    await page.getByLabel("초대 작업 공간").selectOption(setup.workspaceId);
    await page.getByRole("button", { name: "초대 권한 검토·저장" }).click();
    const stepup = page.getByRole("dialog", {
      name: "검토한 고위험 작업 · 일회성 추가 인증",
    });
    await expect(stepup).toContainText("browser-viewer@example.org");
    await stepup
      .getByLabel("현재 제작자 비밀번호")
      .fill("browser-administrator-test-2026");
    await stepup.getByLabel("일회용 복구 코드 사용").check();
    await stepup.getByLabel("복구 코드", { exact: true }).fill(recoveryCode);
    await stepup.getByRole("button", { name: "이 작업만 인증·계속" }).click();
    await expect(stepup).toHaveCount(0);
    await expect(page.getByLabel("초대 결과")).not.toHaveValue("");
    const invite = { token: await page.getByLabel("초대 결과").inputValue() };
    await page.getByRole("button", { name: "제작자 로그아웃" }).click();
    await expect(
      page.getByRole("heading", { name: "Automade 제작 작업 공간" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "계정 만들기", exact: true })
      .click();
    await page.getByLabel("제작자 이메일").fill("browser-viewer@example.org");
    await page
      .getByLabel("제작자 초대 토큰 · 초대받은 경우")
      .fill(invite.token);
    await page.getByLabel("이름", { exact: true }).fill("초대된 검토자");
    await page
      .getByLabel("비밀번호", { exact: true })
      .fill("browser-viewer-test-password-2026");
    await page.getByRole("button", { name: "제작자 계정 등록" }).click();
    await expect(
      page.getByText(
        "제작자 계정 등록을 확인했습니다. 등록한 계정으로 로그인하세요.",
      ),
    ).toBeVisible();
    await page.getByLabel("제작자 이메일").fill("browser-viewer@example.org");
    await page
      .getByLabel("비밀번호", { exact: true })
      .fill("browser-viewer-test-password-2026");
    await page
      .getByRole("button", { name: "제작자 로그인", exact: true })
      .click();
    await expect(page.getByLabel("프로젝트 이름")).toHaveValue(
      "관리자만 편집할 원본",
    );
    await expect(
      page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
    ).toBeDisabled();
    await expect(page.getByLabel("프로젝트 이름")).toBeDisabled();
    await expect(
      page.getByText("읽기 전용", { exact: false }).first(),
    ).toBeVisible();
    if (
      await page.getByRole("button", { name: "속성 열기", exact: true }).count()
    )
      await page
        .getByRole("button", { name: "속성 열기", exact: true })
        .click();
    const collaboration = page.locator(".collaboration-panel");
    await collaboration.locator("summary").first().click();
    await collaboration
      .getByLabel("검토 의견", { exact: true })
      .fill("읽기 담당의 실제 검토 의견");
    await collaboration
      .getByRole("button", { name: "현재 필드에 의견 저장" })
      .click();
    await expect(
      collaboration.getByText("읽기 담당의 실제 검토 의견", { exact: true }),
    ).toBeVisible();
    await expect(
      collaboration.getByRole("button", { name: "해결 표시" }).first(),
    ).toBeDisabled();
    await page.getByRole("button", { name: "운영", exact: true }).click();
    await page.locator(".system-panel summary").first().click();
    await page
      .locator(".system-panel")
      .getByRole("button", { name: "릴리스·실험", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "지표·기간·보호 조건 검토" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "실제 배정·표본·보호 지표 확인" })
      .click();
    await expect(page.getByText("표본 부족 · 판단 보류")).toBeVisible();
    const assigned = await page.evaluate(
      async (target) => {
        const experiments = (
          await (
            await fetch(
              `/api/advancement/runtime/experiments?projectId=${target.projectId}&environmentId=${target.environmentId}`,
            )
          ).json()
        ).data;
        const report = (
          await (
            await fetch(
              `/api/advancement/runtime/experiments/${experiments[0].id}/report?projectId=${target.projectId}&environmentId=${target.environmentId}`,
            )
          ).json()
        ).data;
        return report.variants.reduce(
          (sum: number, row: { assigned: number }) => sum + row.assigned,
          0,
        );
      },
      { projectId: project.id, environmentId: setup.environmentId },
    );
    expect(assigned).toBeGreaterThanOrEqual(2);
    const namespaces = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name),
    );
    expect(
      namespaces.filter((name) => name?.startsWith("automade-studio:creator:")),
    ).toHaveLength(2);
    await page.getByRole("button", { name: "제작자 로그아웃" }).click();
    await page
      .getByRole("button", { name: "재설정 요청", exact: true })
      .first()
      .click();
    await page.getByLabel("제작자 이메일").fill("browser-viewer@example.org");
    await page
      .locator("form")
      .getByRole("button", { name: "재설정 요청", exact: true })
      .click();
    await expect(
      page.getByText(/재설정 메일 공급자가 연결되지 않아 발송되지 않았습니다/),
    ).toBeVisible();
  } finally {
    await service.close();
  }
});
