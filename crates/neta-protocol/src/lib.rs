use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub machine: Machine,
    pub workspaces: Vec<Workspace>,
    pub leaders: Vec<Leader>,
    pub missions: Vec<Mission>,
    pub agents: Vec<Agent>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Machine {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub roots: Vec<WorkspaceRoot>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    #[serde(default)]
    pub machine_id: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Leader {
    pub workspace_id: String,
    pub session_id: String,
    pub name: String,
    pub state: String,
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub id: String,
    pub number: u64,
    pub workspace_id: String,
    pub name: String,
    pub state: String,
    pub attention: Option<String>,
    pub created_at: String,
    pub worktree: Option<Worktree>,
    pub lead: MissionLead,
    #[serde(default)]
    pub agent_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Worktree {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MissionLead {
    Leader,
    Agent { agent_id: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub mission_id: String,
    pub session_id: String,
    pub name: String,
    pub task: String,
    pub state: String,
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MissionDetail {
    pub mission: Mission,
    pub agents: Vec<Agent>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MissionList {
    pub missions: Vec<Mission>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationBlock {
    pub role: String,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTail {
    pub session_id: String,
    pub blocks: Vec<ConversationBlock>,
    #[serde(default)]
    pub prev_cursor: Option<String>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub session_id: String,
    pub workspace_id: String,
    pub name: String,
    pub role: String,
    pub cwd: String,
    pub provider: String,
    pub model: String,
}

impl Snapshot {
    pub fn leader_target(&self, workspace_id: &str) -> Option<Target> {
        let leader = self
            .leaders
            .iter()
            .find(|leader| leader.workspace_id == workspace_id)?;
        let cwd = self
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)?
            .roots
            .first()?
            .path
            .clone();
        Some(Target {
            session_id: leader.session_id.clone(),
            workspace_id: workspace_id.into(),
            name: leader.name.clone(),
            role: "Workspace leader".into(),
            cwd,
            provider: leader.provider.clone(),
            model: leader.model.clone(),
        })
    }
    pub fn agent_target(&self, agent_id: &str) -> Option<Target> {
        let agent = self.agents.iter().find(|agent| agent.id == agent_id)?;
        let mission = self
            .missions
            .iter()
            .find(|mission| mission.id == agent.mission_id)?;
        let cwd = mission
            .worktree
            .as_ref()
            .map(|w| w.path.clone())
            .or_else(|| {
                self.workspaces
                    .iter()
                    .find(|w| w.id == mission.workspace_id)?
                    .roots
                    .first()
                    .map(|r| r.path.clone())
            })?;
        Some(Target {
            session_id: agent.session_id.clone(),
            workspace_id: mission.workspace_id.clone(),
            name: agent.name.clone(),
            role: agent.task.clone(),
            cwd,
            provider: agent.provider.clone(),
            model: agent.model.clone(),
        })
    }
    pub fn mission_target(&self, mission_id: &str) -> Option<Target> {
        let mission = self
            .missions
            .iter()
            .find(|mission| mission.id == mission_id)?;
        match &mission.lead {
            MissionLead::Leader => self.leader_target(&mission.workspace_id),
            MissionLead::Agent { agent_id } => self.agent_target(agent_id),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BridgeEvent {
    Snapshot {
        workspace_id: String,
        snapshot: Snapshot,
    },
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_envelope_accepts_typescript_camel_case() {
        let json = r#"{"type":"snapshot","workspaceId":"w","snapshot":{"machine":{"name":"local"},"workspaces":[{"id":"w","name":"repo","roots":[{"machineId":"m","path":"/repo"}]}],"leaders":[{"workspaceId":"w","sessionId":"s","name":"Ada","state":"idle","provider":"pi","model":"m"}],"missions":[],"agents":[]}}"#;
        let BridgeEvent::Snapshot {
            workspace_id,
            snapshot,
        } = serde_json::from_str(json).expect("TS envelope")
        else {
            panic!("snapshot")
        };
        assert_eq!(workspace_id, "w");
        assert_eq!(snapshot.leader_target("w").expect("leader").session_id, "s");
    }
}

pub fn status_label(state: &str) -> &'static str {
    match state {
        "blocked" => "NEEDS YOU",
        "failed" => "FAILED",
        "readyToClose" => "READY",
        "mergedNotClosed" => "MERGED",
        "closed" | "completed" | "archived" => "DONE",
        "idle" => "IDLE",
        _ => "RUNNING",
    }
}

pub fn started_label(value: &str) -> String {
    value.get(11..16).unwrap_or("--:--").to_owned()
}
