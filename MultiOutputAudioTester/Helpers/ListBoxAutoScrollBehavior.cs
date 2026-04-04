using System.Collections.Specialized;
using System.Windows;
using System.Windows.Controls;

namespace MultiOutputAudioTester.Helpers;

public static class ListBoxAutoScrollBehavior
{
    public static readonly DependencyProperty AutoScrollToEndProperty =
        DependencyProperty.RegisterAttached(
            "AutoScrollToEnd",
            typeof(bool),
            typeof(ListBoxAutoScrollBehavior),
            new PropertyMetadata(false, OnAutoScrollToEndChanged));

    public static bool GetAutoScrollToEnd(DependencyObject obj)
    {
        return (bool)obj.GetValue(AutoScrollToEndProperty);
    }

    public static void SetAutoScrollToEnd(DependencyObject obj, bool value)
    {
        obj.SetValue(AutoScrollToEndProperty, value);
    }

    private static void OnAutoScrollToEndChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is not ListBox listBox)
        {
            return;
        }

        if ((bool)e.NewValue)
        {
            listBox.Loaded += OnListBoxLoaded;
        }
        else
        {
            listBox.Loaded -= OnListBoxLoaded;
            UnsubscribeFromCollection(listBox);
        }
    }

    private static void OnListBoxLoaded(object sender, RoutedEventArgs e)
    {
        if (sender is not ListBox listBox)
        {
            return;
        }

        SubscribeToCollection(listBox);
        ScrollToLastItem(listBox);
    }

    private static readonly DependencyProperty CollectionSubscriptionProperty =
        DependencyProperty.RegisterAttached(
            "CollectionSubscription",
            typeof(CollectionSubscription),
            typeof(ListBoxAutoScrollBehavior),
            new PropertyMetadata(null));

    private static void SubscribeToCollection(ListBox listBox)
    {
        UnsubscribeFromCollection(listBox);

        if (listBox.ItemsSource is not INotifyCollectionChanged collection)
        {
            return;
        }

        NotifyCollectionChangedEventHandler handler = (_, args) =>
        {
            if (args.Action is NotifyCollectionChangedAction.Add or NotifyCollectionChangedAction.Reset)
            {
                listBox.Dispatcher.InvokeAsync(() => ScrollToLastItem(listBox));
            }
        };

        collection.CollectionChanged += handler;
        listBox.SetValue(CollectionSubscriptionProperty, new CollectionSubscription(collection, handler));
    }

    private static void UnsubscribeFromCollection(ListBox listBox)
    {
        if (listBox.GetValue(CollectionSubscriptionProperty) is not CollectionSubscription subscription)
        {
            return;
        }

        subscription.Collection.CollectionChanged -= subscription.Handler;
        listBox.ClearValue(CollectionSubscriptionProperty);
    }

    private static void ScrollToLastItem(ListBox listBox)
    {
        if (listBox.Items.Count == 0)
        {
            return;
        }

        var lastItem = listBox.Items[listBox.Items.Count - 1];
        listBox.ScrollIntoView(lastItem);
    }

    private sealed record CollectionSubscription(INotifyCollectionChanged Collection, NotifyCollectionChangedEventHandler Handler);
}
