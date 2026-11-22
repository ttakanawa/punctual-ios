import { sign } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const api = new URL("https://api.appstoreconnect.apple.com");
const configurationFile = new URL("../infra/xcode-cloud/testflight.json", import.meta.url);

function env(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name} in the appstore-connect GitHub environment.`);
    return value;
}

function token() {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "ES256", kid: env("APP_STORE_CONNECT_KEY_ID"), typ: "JWT" };
    const claims = {
        iss: env("APP_STORE_CONNECT_ISSUER_ID"),
        iat: now,
        exp: now + 120,
        aud: "appstoreconnect-v1",
    };
    const unsigned = [header, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
    const signature = sign("sha256", Buffer.from(unsigned), {
        key: env("APP_STORE_CONNECT_PRIVATE_KEY"),
        dsaEncoding: "ieee-p1363",
    });
    return `${unsigned}.${signature.toString("base64url")}`;
}

async function request(path, { method = "GET", data } = {}) {
    const url = new URL(path, api);
    if (url.origin !== api.origin) throw new Error("Unexpected App Store Connect API origin.");
    const response = await fetch(url, {
        method,
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token()}`,
            "Content-Type": "application/json",
        },
        body: data ? JSON.stringify({ data }) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        const detail = problem.errors?.map(({ code, detail }) => `${code}: ${detail}`).join("; ");
        throw new Error(`${method} ${url.pathname} returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
}

function desiredChanges(current, configuration) {
    if (current.containerFilePath !== configuration.project) {
        throw new Error(`Expected Xcode project ${configuration.project}, got ${current.containerFilePath}.`);
    }
    const archive = current.actions.filter((action) => action.actionType === "ARCHIVE");
    if (archive.length !== 1 || archive[0].scheme !== configuration.scheme ||
        archive[0].platform !== configuration.platform || !archive[0].isRequiredToPass) {
        throw new Error("Expected one required Archive action for the configured scheme and platform.");
    }
    if (!configuration.actionTypes.includes("ARCHIVE")) {
        throw new Error("The distribution workflow must retain the Archive action.");
    }
    const desired = {
        actions: current.actions.filter((action) => configuration.actionTypes.includes(action.actionType)),
        ...configuration.startConditions,
    };
    return Object.fromEntries(Object.entries(desired).filter(([name, value]) =>
        !isDeepStrictEqual(current[name] ?? null, value)));
}

async function start(workflow, repository) {
    if (!workflow.attributes.isEnabled) throw new Error("The configured Xcode Cloud workflow is disabled.");
    let nextPage = `/v1/scmRepositories/${encodeURIComponent(repository.id)}/gitReferences?limit=200`;
    while (nextPage) {
        const page = await request(nextPage);
        const main = page.data.find(({ attributes }) =>
            attributes.canonicalName === "refs/heads/main" && !attributes.isDeleted);
        if (main) {
            return request("/v1/ciBuildRuns", {
                method: "POST",
                data: {
                    type: "ciBuildRuns",
                    relationships: {
                        workflow: { data: { type: "ciWorkflows", id: workflow.id } },
                        sourceBranchOrTag: { data: { type: "scmGitReferences", id: main.id } },
                    },
                },
            });
        }
        nextPage = page.links?.next;
    }
    throw new Error("Xcode Cloud cannot see the main branch.");
}

export async function main(operation) {
    if (!["plan", "apply", "start"].includes(operation)) {
        throw new Error("Usage: node Scripts/xcode-cloud.mjs plan|apply|start");
    }
    const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
    const id = env("XCODE_CLOUD_WORKFLOW_ID");
    const path = `/v1/ciWorkflows/${encodeURIComponent(id)}`;
    const { data: workflow, included } = await request(`${path}?include=repository`);
    const repository = included?.find((entry) =>
        entry.type === "scmRepositories" && entry.id === workflow.relationships?.repository?.data?.id);
    const slug = `${repository?.attributes.ownerName}/${repository?.attributes.repositoryName}`;
    if (slug.toLowerCase() !== configuration.repository.toLowerCase()) {
        throw new Error(`Workflow repository is ${slug}; expected ${configuration.repository}.`);
    }

    const changes = desiredChanges(workflow.attributes, configuration);
    const changedFields = Object.keys(changes);
    if (operation === "start") {
        if (changedFields.length) {
            throw new Error("Apply the Xcode Cloud configuration before starting TestFlight.");
        }
        const { data: build } = await start(workflow, repository);
        const summary = `Queued Xcode Cloud build ${build.attributes?.number ?? build.id} (${build.id}).\n`;
        console.log(summary.trim());
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    } else if (!changedFields.length) {
        console.log("Xcode Cloud matches the configuration.");
    } else {
        const before = Object.fromEntries(changedFields.map((name) => [name, workflow.attributes[name] ?? null]));
        console.log(JSON.stringify({ before, after: changes }, null, 2));
        if (operation === "apply") {
            await request(path, { method: "PATCH", data: { type: "ciWorkflows", id, attributes: changes } });
            const { data: updated } = await request(path);
            if (Object.keys(desiredChanges(updated.attributes, configuration)).length) {
                throw new Error("The updated workflow still differs from the configuration.");
            }
            console.log("Updated the Xcode Cloud workflow.");
        }
    }
}

if (import.meta.main) {
    main(process.argv[2]).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
