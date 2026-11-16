
namespace CodexWeb.Api.Core.Entities;

public enum CodexTaskStatus
{
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled
}

public sealed class CodexTask
{
    public Guid Id { get; private set; }

    public string Prompt { get; private set; }

    public CodexTaskStatus Status { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset? CompletedAt { get; private set; }

    private CodexTask()
    {
        Prompt = string.Empty;
    }

    public CodexTask(string prompt)
    {
        if (string.IsNullOrWhiteSpace(prompt))
            throw new ArgumentException(
                "A tarefa não pode estar vazia.",
                nameof(prompt)
            );

        Id = Guid.NewGuid();
        Prompt = prompt;
        Status = CodexTaskStatus.Pending;
        CreatedAt = DateTimeOffset.UtcNow;
    }

    public void Start()
    {
        if (Status != CodexTaskStatus.Pending)
            throw new InvalidOperationException(
                "Somente tarefas pendentes podem iniciar."
            );

        Status = CodexTaskStatus.Running;
    }

    public void Complete()
    {
        if (Status != CodexTaskStatus.Running)
            throw new InvalidOperationException(
                "Somente tarefas em execução podem ser concluídas."
            );

        Status = CodexTaskStatus.Completed;
        CompletedAt = DateTimeOffset.UtcNow;
    }

    public void Fail()
    {
        if (Status != CodexTaskStatus.Running)
            throw new InvalidOperationException(
                "Somente tarefas em execução podem falhar."
            );

        Status = CodexTaskStatus.Failed;
        CompletedAt = DateTimeOffset.UtcNow;
    }

    public void Cancel()
    {
        if (Status != CodexTaskStatus.Pending &&
            Status != CodexTaskStatus.Running)
        {
            throw new InvalidOperationException(
                "Esta tarefa não pode ser cancelada."
            );
        }

        Status = CodexTaskStatus.Cancelled;
        CompletedAt = DateTimeOffset.UtcNow;
    }
}

