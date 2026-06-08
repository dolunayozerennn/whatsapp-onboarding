import os
import requests
import json

TOKEN = "14ac7442-43fc-480a-b7e2-e8b5dacf1bb3"
PROJECT_ID = "5f346c33-6af1-4788-8405-34133c98451b"
SERVICE_ID = "64673112-d65a-4286-abc7-808af50901ce"
ENV_ID = "f2000489-b711-4224-9fd4-44791bdb59d4"
URL = "https://backboard.railway.app/graphql/v2"

headers = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json"
}

print("1. Fetching Service Status...")
deps_query = """
query {
  deployments(
    input: {
      projectId: "%s"
      environmentId: "%s"
      serviceId: "%s"
    }
  ) {
    edges {
      node {
        id
        status
        createdAt
      }
    }
  }
}
""" % (PROJECT_ID, ENV_ID, SERVICE_ID)

res_deps = requests.post(URL, headers=headers, json={"query": deps_query}).json()
deps = res_deps.get("data", {}).get("deployments", {}).get("edges", [])
if deps:
    latest = deps[0]["node"]
    print("STATUS:", latest["status"])
    latest_id = latest["id"]
else:
    print("STATUS: NOT FOUND")
    latest_id = None

print("\\n2. Fetching Variables...")
vars_query = """
query {
  variables(projectId: "%s", environmentId: "%s", serviceId: "%s")
}
""" % (PROJECT_ID, ENV_ID, SERVICE_ID)
res_vars = requests.post(URL, headers=headers, json={"query": vars_query}).json()
variables = res_vars.get("data", {}).get("variables", {})
required_vars = [
    "NOTION_API_KEY",
    "NOTION_DATABASE_ID",
    "MANYCHAT_API_TOKEN",
    "GROQ_API_KEY",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "PORT",
    "CRON_TIMEZONE",
    "CRON_SCHEDULE"
]
for rv in required_vars:
    if rv in variables:
        print(f"{rv}: SET")
    else:
        print(f"{rv}: MISSING")

print("\\n3. Fetching Health Check...")
try:
    health_res = requests.get("https://whatsapp-onboarding-production.up.railway.app/health")
    print("HEALTH STATUS:", health_res.status_code)
    print("HEALTH BODY:", health_res.text)
except Exception as e:
    print("HEALTH ERROR:", e)

print("\\n4. Fetching Logs...")
if latest_id:
    logs_query = """
    query {
      deploymentLogs(deploymentId: "%s", limit: 2000) {
        message
        timestamp
      }
    }
    """ % latest_id
    res_logs = requests.post(URL, headers=headers, json={"query": logs_query}).json()
    logs = res_logs.get("data", {}).get("deploymentLogs", [])
    
    fatal_errors = []
    cron_runs = []
    restarts = []
    
    for l in logs:
        msg = l.get("message", "")
        ts = l.get("timestamp", "")
        
        if any(x in msg for x in ["FATAL", "Error", "Traceback", "Exception"]):
            fatal_errors.append(f"{ts}: {msg}")
        
        if "node server.js" in msg or "Starting" in msg or "listening" in msg.lower():
            restarts.append(f"{ts}: {msg}")
            
        if "cron" in msg.lower() or "scheduled" in msg.lower() or "onboarding check" in msg.lower() or "starting daily onboarding check" in msg.lower() or "Daily onboarding check completed" in msg:
            cron_runs.append(f"{ts}: {msg}")

    print(f"Total Logs Analysed: {len(logs)}")
    print(f"Errors Found: {len(fatal_errors)}")
    for e in fatal_errors[-5:]:
        print(" -", e)
        
    print(f"Restarts Found: {len(restarts)}")
    for r in restarts[-3:]:
        print(" -", r)
        
    print(f"Cron Runs Found: {len(cron_runs)}")
    for c in cron_runs[-5:]:
        print(" -", c)
