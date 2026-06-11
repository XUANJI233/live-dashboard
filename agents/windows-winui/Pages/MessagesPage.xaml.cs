using System.Collections.ObjectModel;
using LiveDashboardAgent.Services;
using LiveDashboardAgent.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace LiveDashboardAgent.Pages;

public sealed partial class MessagesPage : Page
{
    private bool _loaded;
    private bool _refreshing;

    public ObservableCollection<MessageDisplayItem> Messages { get; } = [];

    public MessagesPage()
    {
        InitializeComponent();
        Loaded += MessagesPage_Loaded;
        RenderMessages();
        RenderDetail(null);
    }

    private async void MessagesPage_Loaded(object sender, RoutedEventArgs e)
    {
        if (_loaded)
        {
            return;
        }
        _loaded = true;
        await RefreshMessagesAsync();
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e)
    {
        await RefreshMessagesAsync();
    }

    private void MessagesList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        RenderDetail(MessagesList.SelectedItem as MessageDisplayItem);
    }

    private async Task RefreshMessagesAsync()
    {
        if (_refreshing)
        {
            return;
        }

        var config = AppServices.ConfigStore.Load();
        var error = config.Validate();
        if (error is not null)
        {
            ShowStatus("配置错误", error, InfoBarSeverity.Error);
            return;
        }

        var selectedId = (MessagesList.SelectedItem as MessageDisplayItem)?.Id ?? "";
        SetRefreshing(true);
        try
        {
            var messages = await AppServices.DeviceMessageHistory.RefreshAsync(config);
            ReplaceMessages(messages.Select(MessageDisplayItem.From), selectedId);
            RenderMessages();
            ShowStatus("Live Dashboard", "消息已刷新。", InfoBarSeverity.Success);
        }
        catch (Exception ex)
        {
            ShowStatus("刷新失败", ex.Message, InfoBarSeverity.Error);
        }
        finally
        {
            SetRefreshing(false);
        }
    }

    private void ReplaceMessages(IEnumerable<MessageDisplayItem> messages, string selectedId)
    {
        Messages.Clear();
        foreach (var message in messages)
        {
            Messages.Add(message);
        }

        if (Messages.Count == 0)
        {
            RenderDetail(null);
            return;
        }

        var selected = Messages.FirstOrDefault(message => message.Id == selectedId) ?? Messages[0];
        MessagesList.SelectedItem = selected;
    }

    private void RenderMessages()
    {
        var hasMessages = Messages.Count > 0;
        MessagesList.Visibility = hasMessages ? Visibility.Visible : Visibility.Collapsed;
        EmptyState.Visibility = hasMessages ? Visibility.Collapsed : Visibility.Visible;
        MessageCountText.Text = hasMessages
            ? $"{Messages.Count} 条最近私聊历史"
            : "最近私聊历史";
    }

    private void RenderDetail(MessageDisplayItem? message)
    {
        var hasMessage = message is not null;
        DetailPanel.Visibility = hasMessage ? Visibility.Visible : Visibility.Collapsed;
        DetailEmptyState.Visibility = hasMessage ? Visibility.Collapsed : Visibility.Visible;
        if (!hasMessage)
        {
            DetailSenderText.Text = "";
            DetailMetaText.Text = "";
            DetailBodyText.Text = "";
            return;
        }

        DetailSenderText.Text = message!.Sender;
        DetailMetaText.Text = message.DetailMeta;
        DetailBodyText.Text = message.Body;
    }

    private void SetRefreshing(bool refreshing)
    {
        _refreshing = refreshing;
        RefreshButton.IsEnabled = !refreshing;
    }

    private void ShowStatus(string title, string message, InfoBarSeverity severity)
    {
        StatusBar.Title = title;
        StatusBar.Message = message;
        StatusBar.Severity = severity;
        StatusBar.IsOpen = true;
    }
}
