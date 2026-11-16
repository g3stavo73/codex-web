
namespace CodexWeb.Api.Core.Entities;

public enum CodexTaskStatus
{
    Pending,
    Starting,
    Running,
    Completed,
    Interrupted,
    Failed,
    Cancelled
}

public sealed class CodexTask
{
    public Guid Id { get; private set; }

    public Guid SessionId { get; private set; }

    public string Prompt { get; private set; }

    public string? CodexTurnId { get; private set; }

    public CodexTaskStatus Status { get; private set; }

    public string? FailureReason { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset? StartedAt { get; private set; }

    public DateTimeOffset? CompletedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    private CodexTask()
    {
        Prompt = string.Empty;
    }

    public CodexTask(Guid sessionId, string prompt)
    {
        if (sessionId == Guid.Empty)
        {
            throw new ArgumentException(
                "The session ID cannot be empty.",
                nameof(sessionId)
            );
        }

        if (string.IsNullOrWhiteSpace(prompt))
        {
            throw new ArgumentException(
                "The task prompt cannot be empty.",
                nameof(prompt)
            );
        }

        Id = Guid.NewGuid();
        SessionId = sessionId;
        Prompt = prompt.Trim();

        Status = CodexTaskStatus.Pending;

        CreatedAt = DateTimeOffset.UtcNow;
        UpdatedAt = CreatedAt;
    }

    public void BeginStarting()
    {
        EnsureStatus(
            CodexTaskStatus.Pending,
            "start"
        );

        Status = CodexTaskStatus.Starting;

        UpdatedAt = DateTimeOffset.UtcNow;
    }

    public void MarkStarted(string codexTurnId)
    {
        if (string.IsNullOrWhiteSpace(codexTurnId))
        {
            throw new ArgumentException(
                "The Codex turn ID cannot be empty.",
                nameof(codexTurnId)
            );
        }

        EnsureStatus(
            CodexTaskStatus.Starting,
            "confirm startup"
        );

        CodexTurnId = codexTurnId.Trim();

        Status = CodexTaskStatus.Running;

        StartedAt = DateTimeOffset.UtcNow;
        UpdatedAt = StartedAt.Value;
    }

    public void MarkCompleted()
    {
        EnsureStatus(
            CodexTaskStatus.Running,
            "complete"
        );

        Finish(CodexTaskStatus.Completed);
    }

    public void MarkInterrupted()
    {
        EnsureStatus(
            CodexTaskStatus.Running,
            "interrupt"
        );

        Finish(CodexTaskStatus.Interrupted);
    }

    public void MarkFailed(string? failureReason = null)
    {
        if (Status is not (
            CodexTaskStatus.Pending or
            CodexTaskStatus.Starting or
            CodexTaskStatus.Running
        ))
        {
            throw new InvalidOperationException(
                $"A task with status '{Status}' cannot fail."
            );
        }

        FailureReason = string.IsNullOrWhiteSpace(failureReason)
            ? null
            : failureReason.Trim();

        Finish(CodexTaskStatus.Failed);
    }

    public void Cancel()
    {
        EnsureStatus(
            CodexTaskStatus.Pending,
            "cancel"
        );

        Finish(CodexTaskStatus.Cancelled);
    }

    private void Finish(CodexTaskStatus finalStatus)
    {
        Status = finalStatus;

        CompletedAt = DateTimeOffset.UtcNow;
        UpdatedAt = CompletedAt.Value;
    }

    private void EnsureStatus(
        CodexTaskStatus expected,
        string operation
    )
    {
        if (Status != expected)
        {
            throw new InvalidOperationException(
                $"Cannot {operation} a task with status '{Status}'."
            );
        }
    }
}
