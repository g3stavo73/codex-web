
using System.Threading;
using System.Threading.Tasks;
using CodexWeb.Api.Core.Entities;

namespace CodexWeb.Api.Core.Interfaces;

/// <summary>
/// Coordinates the execution lifecycle of Codex tasks.
/// </summary>
public interface ITaskExecutor
{
    /// <summary>
    /// Starts a pending task inside its associated Codex session.
    ///
    /// The operation returns after Codex accepts the turn and its
    /// identifier is registered in the task.
    /// It does not wait for the turn to complete.
    /// </summary>
    Task StartAsync(
        CodexSession session,
        CodexTask task,
        CancellationToken cancellationToken = default
    );

    /// <summary>
    /// Requests interruption of a running task.
    ///
    /// This method only requests interruption.
    /// The task must be marked as interrupted after the runtime
    /// confirms the final turn status.
    /// </summary>
    Task RequestInterruptionAsync(
        CodexSession session,
        CodexTask task,
        CancellationToken cancellationToken = default
    );
}
