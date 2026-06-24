#!/usr/bin/env tsx
/**
 * Called by .github/workflows/agent-mention.yml to handle @agent-<slug> mention events.
 *
 * 1. Reads the GitHub event from GITHUB_EVENT_PATH
 * 2. Finds the first @agent-<slug> mention in the comment body
 * 3. Invokes the agent Lambda directly (bypasses the 30s AppSync resolver timeout)
 * 4. Posts the agent's reply as a comment using GITHUB_TOKEN
 *
 * Required environment variables (set by setup-github-integration.ts):
 *   GITHUB_EVENT_PATH      — path to the event JSON file (built-in Actions env)
 *   GITHUB_TOKEN           — built-in token for posting comments
 *   INVOKE_AGENT_LAMBDA_ARN — ARN of the invoke-agent Lambda function
 *   AWS_REGION             — AWS region (default us-east-1)
 *   AWS_ACCESS_KEY_ID      — IAM credentials for Lambda invocation
 *   AWS_SECRET_ACCESS_KEY  — IAM credentials for Lambda invocation
 *   GITHUB_BASE_REF        — default branch of the repo (e.g. "main")
 */

import { Octokit } from '@octokit/rest';
import { readFileSync } from 'fs';

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

// ─── SigV4 Lambda invocation (no SDK dependency) ─────────────────────────────

function hexEncode(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return hexEncode(new Uint8Array(hash));
}

async function hmac256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function invokeLambda(
  lambdaArn: string,
  region: string,
  payload: unknown,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
): Promise<unknown> {
  const functionName = lambdaArn.split(':').slice(-1)[0];
  const host = `lambda.${region}.amazonaws.com`;
  const path = `/2015-03-31/functions/${encodeURIComponent(lambdaArn)}/invocations`;
  const body = JSON.stringify(payload);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256(body);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host,
    'x-amz-date': amzDate,
    'x-amz-invocation-type': 'RequestResponse',
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}\n`).join('');
  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${region}/lambda/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256(canonicalRequest)].join('\n');

  const enc = (s: string) => new TextEncoder().encode(s);
  const kDate = await hmac256(enc(`AWS4${credentials.secretAccessKey}`), dateStamp);
  const kRegion = await hmac256(kDate, region);
  const kService = await hmac256(kRegion, 'lambda');
  const kSigning = await hmac256(kService, 'aws4_request');
  const signature = hexEncode(new Uint8Array(await hmac256(kSigning, stringToSign)));

  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: { ...headers, Authorization: authorization },
    body,
  });

  // suppress unused variable warning
  void functionName;

  if (!res.ok) throw new Error(`Lambda HTTP ${res.status}: ${await res.text()}`);
  const result = await res.json() as { errorType?: string; errorMessage?: string; response?: string; sessionId?: string };
  if (result.errorType) throw new Error(`Lambda error: ${result.errorMessage}`);
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set');

  const lambdaArn = process.env.INVOKE_AGENT_LAMBDA_ARN;
  if (!lambdaArn) throw new Error('INVOKE_AGENT_LAMBDA_ARN is not set');

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
  // The agent can use GitHub MCP tools (create_branch, create_or_update_file, create_pull_request, etc.)
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

  const result = await invokeLambda(
    lambdaArn,
    awsRegion,
    { arguments: { agentSlug, prompt } },
    { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey, sessionToken: awsSessionToken },
  ) as { response: string; sessionId: string };

  const response = result.response;
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
