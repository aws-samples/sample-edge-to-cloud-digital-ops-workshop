#!/usr/bin/env tsx
/**
 * Called by .github/workflows/agent-mention.yml to handle @agent-<slug> mention events.
 *
 * 1. Reads the GitHub event from GITHUB_EVENT_PATH
 * 2. Finds the first @agent-<slug> mention in the comment body
 * 3. SigV4-signs a POST to the AgentCore runtime /invocations endpoint (sync mode)
 * 4. Posts the agent's reply as a comment using GITHUB_TOKEN
 *
 * Required environment variables (set by setup-github-integration.ts):
 *   GITHUB_EVENT_PATH        — path to the event JSON file (built-in Actions env)
 *   GITHUB_TOKEN             — built-in token for posting comments
 *   INVOKE_AGENT_RUNTIME_ARN — ARN of the AgUiHandler AgentCore runtime
 *   AWS_REGION               — AWS region (default us-east-1)
 *   AWS_ACCESS_KEY_ID        — IAM credentials for runtime invocation
 *   AWS_SECRET_ACCESS_KEY    — IAM credentials for runtime invocation
 *   GITHUB_BASE_REF          — default branch of the repo (e.g. "main")
 */

import { Octokit } from '@octokit/rest';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string; type: string };
  pull_request?: unknown;
}

interface GitHubEvent {
  action: string;
  issue?: GitHubIssue;
  comment?: { id: number; body: string; user: { login: string; type: string } };
  sender: { login: string; type: string };
  repository: { full_name: string; owner: { login: string }; name: string };
}

interface RuntimeResponse {
  sessionId: string;
  response?: string;
  error?: string;
}

// ─── Runtime invocation via SigV4 ─────────────────────────────────────────────

async function invokeRuntime(
  runtimeArn: string,
  region: string,
  payload: unknown,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
): Promise<RuntimeResponse> {
  const encodedArn = encodeURIComponent(runtimeArn);
  const url = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`;

  const body = JSON.stringify(payload);

  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
    sha256: Sha256,
  });

  const parsed = new URL(url);
  const signed = await signer.sign({
    method: 'POST',
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    protocol: 'https:',
    headers: {
      host: parsed.hostname,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Runtime HTTP ${res.status}: ${text}`);
  }

  return res.json() as Promise<RuntimeResponse>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set');

  const runtimeArn = process.env.INVOKE_AGENT_RUNTIME_ARN;
  if (!runtimeArn) throw new Error('INVOKE_AGENT_RUNTIME_ARN is not set');

  const awsRegion = process.env.AWS_REGION ?? 'us-east-1';
  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const awsSessionToken = process.env.AWS_SESSION_TOKEN;
  if (!awsAccessKeyId || !awsSecretAccessKey) throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set');

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) throw new Error('GITHUB_TOKEN is not set');

  const event: GitHubEvent = JSON.parse(readFileSync(eventPath, 'utf8'));

  // Loop prevention: never respond to bots
  const senderLogin = event.sender?.login ?? '';
  const senderType = event.sender?.type ?? '';
  if (senderType === 'Bot' || senderLogin.endsWith('[bot]')) {
    console.log(`Skipping bot sender: ${senderLogin}`);
    return;
  }

  const [owner, repo] = event.repository.full_name.split('/');
  const issueNumber = event.issue?.number;
  if (!issueNumber) {
    console.log('No issue number in event; skipping');
    return;
  }

  // comment body for issue_comment events; issue body for issues.assigned
  const rawText = event.comment?.body ?? event.issue?.body ?? '';

  // Match @agent-<slug> — the trigger pattern
  const mentionMatch = rawText.match(/@agent-([\w-]+)/);
  if (!mentionMatch) {
    console.log('No @agent-<slug> mention found; skipping');
    return;
  }

  const agentSlug = mentionMatch[1];
  const userPrompt = rawText.replace(`@agent-${agentSlug}`, '').trim() || event.issue?.title || rawText;

  // Inject structured context so the agent knows the repo, issue, and default branch.
  const defaultBranch = process.env.GITHUB_BASE_REF || 'main';
  const prompt = `\
You are acting on behalf of a GitHub user in the repository ${event.repository.full_name}.

CONTEXT:
- Repository: ${event.repository.full_name}
- Default branch: ${defaultBranch}
- Issue #${issueNumber}: ${event.issue?.title ?? '(no title)'}
- Issue body: ${(event.issue?.body ?? '').slice(0, 500)}
- Triggered by: @${event.sender.login}

USER REQUEST:
${userPrompt}

If your response involves code changes, create a new branch off ${defaultBranch}, commit the changes, and open a pull request. Reference issue #${issueNumber} in the PR description.`;

  console.log(`Agent: "${agentSlug}"  Issue: #${issueNumber}`);
  console.log(`Prompt: ${userPrompt.slice(0, 120)}${userPrompt.length > 120 ? '…' : ''}`);

  const sessionId = randomUUID();
  const result = await invokeRuntime(
    runtimeArn,
    awsRegion,
    { sessionId, prompt, sync: true },
    { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey, sessionToken: awsSessionToken },
  );

  const response = result.response ?? result.error ?? '(no response)';
  console.log(`Agent responded (${response.length} chars)`);

  const octokit = new Octokit({ auth: githubToken });
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: response,
  });

  console.log('Reply posted');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
